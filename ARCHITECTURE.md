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
request. All nineteen tools cost about 16k tokens; that is paid again on each turn, whether or
not a tool is called.

Decisions that follow from this:

- **Profiles.** `--tools=core` (or `PW_MCP_TOOLS=core`) loads only the seven tools of the fix
  loop (run, status, failure, fix, flaky, heal guard, list), about 5k tokens. `triage`,
  `inspect` and `author` cover the other jobs. Profiles are resolved in `resolveToolSelection`
  in `src/server.ts`.
- **Short descriptions, loose schemas.** Descriptions say what a tool returns and when to call
  it, not how it works. Unknown arguments are reported back to the caller rather than
  rejected, so a model that guesses an argument name gets a correction instead of a dead end.
- **Output schemas are optional.** Every result carries `structuredContent`, but its schema
  is more context. `PW_MCP_OUTPUT_SCHEMAS=0` drops it (12k for all tools, 2.6k for `core`).
- **The server does the matching.** `suggest-fix` matches a broken locator against the DOM
  at failure and proves the replacement unique before returning it, so the model reads one
  diff rather than a 150-element snapshot. The [benchmark](bench/RESULTS.md) measures this:
  about 5,500 tokens for one locator fix with `core`, against about 7,900 for Playwright MCP
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
- **The optional Pro client** (`src/utils/pro-client.ts`, `upload` CLI) makes network calls
  only when both `PW_MCP_PRO_KEY` and `PW_MCP_PRO_URL` are set. There is no default URL.
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
  assertion wrapped in a `try` whose `catch` neither rethrows nor asserts, a deleted file.
- **WARN** a test that became weaker or slower to fail: a looser matcher, `expect.soft`, a
  hard wait, `force: true`, an un-awaited web-first assertion, a timeout or retry count blown
  up. A `try` that rethrows is not flagged.

## 6. Diagnosis that survives missing data

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
| A hosted, stateless history store | The local file stays the default. The optional Pro service is the hosted variant. |

## 7. Python projects behind the same tools

A project with no Node Playwright but a pytest configuration (`pytest.ini`, `[tool.pytest…]`,
`conftest.py`, …) is run with `python -m pytest` (`src/utils/pytest-runner.ts`). Results come
from a small plugin the server writes to its temp folder and loads with `-p`, so nothing is
installed in the project; it writes one line per finished test, which keeps killed runs useful
in the same way as the Node live reporter. The result has the same shape as a Node run, so
`get-failure` reads pytest-playwright's traces with the same trace reader. Patching Python
specs, flaky diagnosis and the heal guard are still Node only.

## Roadmap

- Python: locator fixes for `.py` specs (`suggest-fix`), flaky diagnosis through pytest-repeat,
  and heal-guard rules for pytest files.
