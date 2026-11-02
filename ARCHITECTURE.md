# Architecture and design decisions

This file explains how playwright-e2e-mcp is built and why. It is for contributors and for
anyone deciding whether to run it on their code. For what each tool does, see the
[tool reference](docs/tools.md); for the security model, see [SECURITY.md](SECURITY.md).

## The shape of it

```
MCP client (Claude, Cursor, VS Code, Codex…)
   │  stdio, or the HTTP bridge (src/http.ts) for hosted connectors
   ▼
src/server.ts ── registers the tools, picks a tool profile, wires progress + cancel
   │
   ├─ src/tools/*            one file per tool: validate input, call utils, render Markdown
   │                         + structuredContent
   ├─ src/utils/playwright-runner.ts   spawns the project's own Playwright test runner
   ├─ src/utils/report-parser.ts       JSON report → failures, outcomes, stats
   ├─ src/utils/trace-reader.ts        trace.zip → failed action, DOM, network, console
   ├─ src/tools/probe-script.ts        the browser child for the page tools
   └─ src/utils/test-change-guard.ts   the heal guard
```

There are three runtime dependencies: the MCP SDK, zod and axe-core. Playwright is not one of
them: every run and every browser comes from the Playwright already installed in the user's
project, so the version you test with is the version the server uses.

## 1. Tool definitions cost tokens on every request

An MCP client sends every tool's name, description and input schema with every model
request. All twenty tools cost about 12.1k tokens; that is paid again on each turn, whether or
not a tool is called.

Decisions that follow from this:

- **Profiles.** `--tools=core` (or `PW_MCP_TOOLS=core`) loads only the seven tools of the fix
  loop (run, status, failure, fix, flaky, heal guard, list), about 2.3k tokens. `triage`,
  `inspect` and `author` cover the other jobs. Profiles are resolved in `resolveToolSelection`
  in `src/server.ts`.
- **Load on request.** `--tools=auto` registers every tool but lists only the core loop and
  `load-tools`; `load-tools` turns on a profile or named tools and sends one
  `notifications/tools/list_changed`. Only the stdio server keeps that state for the
  connection, so the stateless HTTP bridge (a server per request) lists every tool instead.
- **Short descriptions, loose schemas.** Descriptions say what a tool returns and when to call
  it, not how it works. Unknown arguments are reported back to the caller rather than
  rejected, so a model that guesses an argument name gets a correction instead of a dead end.
- **Compact listed schemas.** `tools/list` leaves out length and item limits, `propertyNames`
  and `$schema` (`src/utils/compact-schema.ts`); the server still validates every call against
  the full schema, so an argument past a limit is refused with the limit named.
- **Compact page views.** `inspect-page` defaults to the locator map, which shows a repeated
  block (product cards, rows) once and names the rest (`src/utils/locator-map.ts`).
- **Output schemas are optional.** Every result carries `structuredContent`, but its schema
  is more context for clients that show it to the model. `PW_MCP_OUTPUT_SCHEMAS=0` drops it.
- **The server does the matching.** `suggest-fix` matches a broken locator against the DOM
  at failure and proves the replacement unique before returning it, so the model reads one
  diff rather than a 150-element snapshot. The [benchmark](bench/RESULTS.md) measures this:
  about 3,000 tokens for one locator fix with `core`, against about 7,200 for Playwright MCP
  plus a shell.

## 2. Verified locators instead of guessed ones

A model that reads raw HTML will guess a CSS selector, and guessed selectors break on the
next redesign. The page tools instead:

- generate candidates in Playwright's own priority order (role + accessible name, label,
  placeholder, test id, text), then **run each one against the live page** and keep only those
  that resolve to exactly one element;
- expose the accessibility snapshot (`inspect-page` with `view: 'aria'`) and hand back a
  ready `toMatchAriaSnapshot` assertion, because roles and names survive restyling;
- reach into iframes (`frameLocator`, `contentFrame()`) and, since popups are common in
  login and payment flows, into new tabs (`switchTab`).

The browser runs in a separate child process (`probe-script.ts`), launched with the
project's Playwright, so a crash or hang there cannot take the server down and is killed
with the request.

## 3. Local first

The server runs on the developer's machine or CI runner and sends nothing anywhere by
default. There is no telemetry and no account.

- **Run history** is a local file, `.playwright-e2e-mcp/history.jsonl`, written by every run.
  `analyze-history` and `diagnose-flaky` read it.
- **The optional shared history client** (`src/utils/history-client.ts`, `upload` CLI) makes
  network calls only when both `PW_MCP_HISTORY_TOKEN` and `PW_MCP_HISTORY_URL` are set, and
  only to the team's own [history server](history-server/README.md). There is no default URL.
- **The update check** (`src/utils/update-check.ts`) runs only inside the `doctor` command:
  one GET to `registry.npmjs.org/playwright-e2e-mcp/latest`, carrying nothing but the
  package name. The MCP server never calls it; `--offline` or `PW_MCP_NO_UPDATE_CHECK=1`
  skips it.
- **Paths are sandboxed.** Every user path must stay inside the project root, checked
  lexically and again with symlinks resolved. Generated files are only ever `*.spec.*` /
  `*.test.*`, and only overwritten when the server wrote them.
- **Playwright is spawned without a shell**, with an argument array and an allowlist of
  flags, so a test name or argument cannot inject a command.
- **The HTTP bridge** serves read-only tools unless it is protected by a token or OAuth,
  gives child processes an allowlisted environment and caps concurrent runs.
- **`bisect-failure`** runs each step in a temporary `git worktree`, so the developer's
  checkout, branch and uncommitted changes are never touched.
- **`blockWrites`** (or `PW_MCP_BLOCK_WRITES=1`) aborts every POST, PUT, PATCH and DELETE
  from the page tools that no mock answers, so steps pointed at a real environment cannot
  place an order or delete data.
- **CI downloads** (`src/utils/ci-artifacts.ts`) happen only when `load-report` is given a
  GitHub Actions run or GitLab job URL, with the user's own `GITHUB_TOKEN` / `GITLAB_TOKEN`.
  The token is sent only to the API host the URL names, every URL passes the private-address
  policy, and archives are unpacked inside `.playwright-e2e-mcp/ci/` with entries that would
  escape the folder dropped.
- **Remote browsers** (`connect`, `PW_MCP_CONNECT`) are opt-in, refused on the HTTP bridge,
  and the endpoint (which often carries an access key) is redacted from errors.

## 4. Logins without passwords in the chat

Re-typing a login on every page check is slow, flaky and leaks credentials into the
transcript. `save-login`:

- logs in once and saves a Playwright `storageState` file inside the project (the same file a
  Playwright setup project writes), which the page tools and tests reuse;
- checks a saved session before logging in again, so a valid one is left alone and an
  expired one refreshes itself;
- fills secrets from `{{env:NAME}}` (only from allowlisted variable prefixes) and one-time
  codes from `{{totp}}`, generated in the browser child at the moment they are typed
  (`src/utils/totp.ts`, RFC 6238). Neither value passes through the model.

## 5. The heal guard

AI agents are good at turning red tests green, and one of the ways is to test less: delete
the assertion that failed, add `.skip`, wrap the step in `try {} catch {}`. The heal guard
(`check-test-change`, and `playwright-e2e-mcp guard` for CI) compares each changed test with
its old self and blocks those changes.

- **Lexical, not a full parser.** Strings and comments are masked first, so their words never
  count, then each `test(...)` is matched across versions by its describe path and title. This
  needs no TypeScript or Babel dependency, handles files that do not compile yet (an agent's
  half-finished edit), and runs in milliseconds.
- **BLOCK** a test that checks less: fewer assertions, a removed or skipped test, `.only`, an
  assertion wrapped in a `try` whose `catch` neither rethrows nor asserts, an assertion that
  always ran moved under an `if` (or after `&&` / `?`), a deleted file.
- **WARN** a test that became weaker or slower to fail: a looser matcher, `expect.soft`, a
  hard wait, `force: true`, an un-awaited web-first assertion, an early `return` before later
  assertions, a timeout or retry count blown up. A `try` that rethrows is not flagged.
- **Run time, not just text.** A lexical scan can always be dodged by a clever enough edit, so
  `runtime: true` runs the old version (a temporary copy next to the spec) and the new one and
  counts the `expect` steps each test executed, through the attempts reporter's `onStepEnd`.
  Fewer assertions at run time is a BLOCK, whatever the code looks like. It is opt-in because it
  runs the tests twice.
- **pytest too.** `test_*.py` files get their own masker and measures (`assert`, `expect(...)`,
  pytest marks, `try/except: pass`, snake_case matchers) feeding the same comparison.

## 6. Hydration races and mock drift

Two ways a suite stays green while users see a broken app:

- **Clicking before hydration.** Server-rendered HTML is actionable before the framework has
  attached its handlers. The trace reader lines up input actions with the network log (both use
  the trace's monotonic clock): a click or fill that started while page scripts were still
  downloading, followed by a failing step, is reported as a possible hydration race, and
  hydration errors are picked out of the console. `inspect-page` adds an init script that
  watches for each framework's public hydration sign (React's root container, Vue's
  `__vue_app__`, Astro islands losing `ssr`) and measures how long controls were on screen
  before it. `audit-tests` flags a click right after `goto` only when `package.json` depends on
  a server-rendering framework, to keep false alarms down.
- **Mocks that drifted.** `check-mocks` reads `route.fulfill` bodies with a small literal
  parser (objects, arrays, strings, numbers, booleans, Python's `True`/`None`); anything computed
  is marked unknown and left out, so every finding is about a field the mock really states. It
  compares shapes, not values, sends only GET requests (write mocks are listed, never
  replayed), and checks every redirect hop against the URL policy.

## 7. Diagnosis that survives missing data

- **No trace?** `get-failure` still returns the message, code frame, expected vs actual,
  stack and failure kind from the JSON report, and says how to capture a trace next time.
  `run-test` passes `--trace=retain-on-failure` unless the caller sets its own `--trace`.
- **No report?** A Playwright process that is killed or crashes never writes its JSON report.
  Every run therefore also loads a small reporter (`src/utils/live-reporter.ts`) that writes
  each result as its test ends; when the JSON report is missing, the failures that finished
  are rebuilt from it and the result is marked partial.
- **Long runs** send MCP progress notifications when the client asks for them, are killed
  with their whole process tree when the request is cancelled, and can run in the
  background (`background: true` + `get-run-status`) for clients with short tool timeouts.

## Decisions not taken, and why

| Idea | Decision |
| --- | --- |
| Rewrite the heal guard on Babel/TypeScript ASTs | Not now. The lexical scan already covers the rules, needs no dependency and works on code that does not parse. |
| AST slicing of the failing test for `get-failure` | Not needed: `get-failure` sends Playwright's few-line code frame, not the file. |
| MCP tasks for long runs | Waiting for SDK support. Tasks are an optional extension in the 2026 spec; progress, cancel and background runs cover the need today. |
| A hosted, stateless history store | The local file stays the default. `history-server/` is the self-hosted shared variant (file or Postgres storage). |

## 8. Python projects behind the same tools

A project with no Node Playwright but a pytest configuration (`pytest.ini`, `[tool.pytest…]`,
`conftest.py`, …) is run with `python -m pytest` (`src/utils/pytest-runner.ts`). Results come
from a small plugin the server writes to its temp folder and loads with `-p`, so nothing is
installed in the project; it writes one line per finished test, which keeps killed runs useful
in the same way as the Node live reporter. The result has the same shape as a Node run, so
`get-failure` reads pytest-playwright's traces with the same trace reader, and the heal guard
and `check-mocks` read `.py` files. `suggest-fix` converts Python locators to the TypeScript
form the healer works on and back (`src/utils/python-locator.ts`), so `.py` specs get the same
verified fixes. Flaky diagnosis is still Node only.

## Roadmap

- Python: flaky diagnosis through pytest-repeat.
