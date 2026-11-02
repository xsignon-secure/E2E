# Tool reference

All paths are relative to the project root. Every tool except `get-run-status`
accepts an optional `projectRoot`, which must sit inside the server's allowed roots.

## run-test

Runs Playwright and returns stats, failures, failure kinds and fix hints.

| Argument | Type | Notes |
| --- | --- | --- |
| `testFiles` | string[] | Files or directories; `file:line` supported. Omit to run everything |
| `grep` | string | Only tests whose title matches this regex |
| `browser` | `chromium` \| `firefox` \| `webkit` | Matched against config project names |
| `background` | boolean | Return a run id at once and keep running; follow it with `get-run-status` |
| `headed` | boolean | Visible browser window |
| `timeoutMs` | number | Wall-clock limit for the run (default 120000); partial results are returned past it |
| `testTimeoutMs` | number | Per-test timeout |
| `workers`, `retries` | number | Passed to Playwright |
| `config` | string | Config path, or 1-based index when there are several |
| `retryOnFailure` | boolean | Retry failures once before reporting (default true; ignored when `retries` is set) |
| `lastFailed` | boolean | Re-run only the tests that failed last time |
| `changed` | boolean \| string | Only tests affected by changes (`--only-changed`): `true` = uncommitted, or a git ref like `origin/main` (0.14.0+) |
| `args` | string[] | Allowlisted Playwright flags such as `--repeat-each=N`, `--max-failures=N`, `--update-snapshots`, `--shard=1/3`, `--trace=on`; path-taking flags are rejected |

Traces are captured on failure automatically so `get-failure` can show the DOM.
Clients that send a progress token get live progress while the run goes.
Failures that share a kind and first error line are grouped (0.4.0+): each
cause is shown once in full, the other tests under it as one line each, and
their `index` numbers stay the ones `get-failure` takes.

## get-failure

| Argument | Type | Notes |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default 1) |

Returns the message and code frame, expected vs actual, stack, failure kind and
diagnosis, console output, the DOM snapshot at failure with the failed action and
its selector, failed network requests, console errors and warnings, and next steps.
Since 0.12.0 it also flags a **possible hydration race** (a click or fill that ran
while the page's scripts were still downloading) and hydration errors in the
console; `diagnose-flaky` repeats the note when a failing run shows it.

## load-report

Loads a run from CI (0.5.0+) so the other tools work on it.

| Argument | Type | Notes |
| --- | --- | --- |
| `report` | string | Required: JSON report inside the project, a folder of blob-report zips from sharded jobs (merged with `playwright merge-reports`), or (0.13.0+) a GitHub Actions run URL / GitLab job URL, downloaded with `GITHUB_TOKEN` / `GITLAB_TOKEN` |
| `traceDirs` | string[] | Where the job's `test-results` artifact was unpacked (default: the report's folder and its parent) |
| `commit`, `branch` | string | Override the report metadata |
| `record` | boolean | Add the run to the history (default true) |
| `timeoutMs` | number | Limit for merging blob reports (default 120000) |

CI paths are mapped onto the checkout (the CI root is the folder of the
report's config file). Returns the usual run result headed "Imported run", the
source, commit and build link, and how many failures have a trace. The run
becomes the last run for `get-failure`, `suggest-fix` and `diagnose-flaky`.

## inspect-page

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required, full http(s) URL |
| `selector` | string | Inspect only matches of this CSS selector |
| `waitFor` | string | Wait for a selector (CSS or `text=...`) first |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` | Navigation wait |
| `includeHtml` | boolean | Include rendered HTML (capped by `maxHtmlChars`, default 20000) |
| `timeoutMs` | number | Default 45000 |
| `view` | `elements` \| `locators` \| `aria` | `locators` (default): compact map of interactive elements with verified locators, repeated blocks shown once; `elements`: full DOM inventory; `aria` (0.5.0+): accessibility snapshot of the page or of `selector`, with a `toMatchAriaSnapshot` assertion |
| `storageState` | string | Playwright storageState JSON inside the project (signed-in session); defaults to `PW_MCP_STORAGE_STATE` |
| `headers` | object | Extra HTTP headers |
| `actions` | array | Up to 20 steps after load: `{ type: click\|dblclick\|fill\|press\|check\|uncheck\|select\|hover\|wait\|goto, locator?, value?, url?, ms? }`. Locators may start with `frameLocator('#frame')` or use `.contentFrame()` for iframes (0.6.1+). `{ type: 'switchTab', value?: 'last'\|'first'\|'2'\|text in URL or title }` moves to a popup or new tab (0.8.0+) |
| `actionTimeoutMs` | number | How long each action waits for its element (0.6.1+, default 10000) |
| `routes` | array | Up to 20 network mocks before load, first match wins: `{ url (glob), method?, status?, json? \| body?, contentType?, headers?, abort?, delayMs? }` (0.5.0+). The result reports hits per mock |
| `blockResources` | array | Skip `image`, `media`, `font`, `stylesheet`, `trackers` requests (0.14.0+) |
| `offline` | boolean | Go offline after load, before `actions` (0.14.0+) |
| `har` | object | `{ path, mode?: replay\|record, url?, notFound?: abort\|fallback }` (0.5.0+): replay requests from a HAR inside the project, or record the traffic to one. `routes` still win |
| `browser` | `chromium` \| `firefox` \| `webkit` | Engine (0.5.0+, default chromium); must be installed |
| `viewport` | object | `{ width, height }` |
| `connect` | string | Remote browser (0.13.0+): `ws(s)://` Playwright server endpoint or `cdp:` + DevTools URL; `{{env:NAME}}` tokens allowed; default `PW_MCP_CONNECT` |

Returns each element's Playwright locators proven unique on the page (role +
name first), unique CSS selector, tag, visibility, box, text and attributes,
plus console messages. `validate-selector`, `compare-visual-state`,
`audit-accessibility` and `audit-performance` take the same `storageState`,
`headers`, `actions`, `routes`, `har`, `browser` and `viewport`
(`audit-performance` is Chromium-only). On a server-rendered page (0.12.0+) a
**Hydration** line names the framework and how long controls were on screen
before hydration, with the wait to add to the tests (`html[data-hydrated]` set by
a root effect, or `astro-island[ssr]` gone for Astro).

## validate-selector

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `selector` | string | Required: CSS, a Playwright selector, or a locator such as `getByRole('button', { name: 'Save' })` |
| `timeoutMs` | number | Default 45000 |

Verdicts: `✅ VALID — N matches` with samples and a unique locator for each,
a strict-mode warning when more than one matches, `✅ VALID — 0 matches` with
advice, or `❌ INVALID` with the parse error.

## list-tests

| Argument | Type | Notes |
| --- | --- | --- |
| `config` | string | Config path or index |
| `testDir` | string | Restrict to a directory |
| `filter` | string | Case-insensitive substring of `file › title` |
| `limit` | number | Default 500 |

Falls back to a source scan when Playwright cannot list (broken install or spec).

## generate-e2e-test

| Argument | Type | Notes |
| --- | --- | --- |
| `description` | string | Required: what the test should cover |
| `pageUrl` | string | Start page (default: `baseURL` / `webServer.url`) |
| `testDir`, `file` | string | Where to write; `file` must end in `.spec.*` or `.test.*` |
| `write` | boolean | Write to disk (default true) |
| `overwrite` | boolean | Replace a spec this tool generated earlier |
| `liveInspect` | boolean | Cross-check selectors on the live page |
| `steps` | array | Walk the flow (0.5.0+): up to 30 steps in the `actions` format, run on the live page first |
| `assertScope` | string | With `steps`: CSS scope of the end-state aria snapshot (default `body`) |
| `storageState` | string | With `steps`: session for the walk, also set in the spec with `test.use` |
| `verify`, `project`, `timeoutMs` | | With `steps`: run the written spec once (default true) |
| `config` | string | As above |

With `steps`, a step that fails on the live page stops the walk and nothing is
written. Otherwise the spec replays the steps and asserts the URL path and the
aria snapshot where the flow landed (its headings when it is over 60 lines),
then runs once; a failing first run keeps the file and shows the error.

## compare-visual-state

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `name` | string | Baseline id, e.g. `checkout-page` |
| `action` | `compare` \| `baseline` | Default `compare`; `baseline` re-captures the reference |
| `selector` | string | Capture one element |
| `fullPage` | boolean | Full scrollable page |
| `mask` | string[] | Selectors/locators hidden from both images (clocks, ads); saved with the baseline (0.14.0+) |
| `tolerance` | number | Percent of pixels allowed to differ (default 0.1) |
| `pixelThreshold` | number | Per-pixel channel delta (default 60) |
| `waitUntil`, `waitFor`, `timeoutMs` | | As `inspect-page` |

Baselines live in `.pw-mcp/visual/`.

## diagnose-flaky

| Argument | Type | Notes |
| --- | --- | --- |
| `testFiles` | string[] | Default: tests that failed in the last run |
| `runs` | number | 2 to 10 (default 3) |
| `isolate` | boolean | Repeat fully parallel (`workers` default 4), then repeat the failing tests with one worker (0.3.0+) |
| `order` | boolean | Run the target files in `runs` random orders with one worker (`--shuffle`, Playwright 1.64+), replay a failing order, and name the test it relies on or is broken by (0.4.0+) |
| `separateProcesses` | boolean | One Playwright process per run instead of one `--repeat-each` process; slower (0.3.0+) |
| `browser`, `headed`, `workers`, `config` | | As `run-test` |
| `timeoutMs` | number | Per run (default 120000); the single `--repeat-each` process gets this × `runs` |

Runs with retries disabled and returns, per test, passes, failures, duration
spread, first error and `CONSISTENTLY FAILING`, `FLAKY` or `NOT REPRODUCING`,
plus the verdict block for the worst test. With `isolate`, a second table reads
each failing test as "fails only in parallel", "flaky even alone" or "fails
alone too". With `order`, a third section reads each test as "order
dependent", "flaky regardless of order" or "fails in every order", with the
`--shuffle=<seed>` command that reproduces it. `PW_MCP_SHUFFLE_SEEDS=1,2,3`
on the server replays given seeds instead of random ones. Versions before 0.3.0 return one run-level verdict and a per-run
table instead.

## audit-accessibility

Runs axe-core (0.4.0+) on a live page and returns WCAG violations, worst first.

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `standard` | `wcag2a` \| `wcag2aa` \| `wcag21aa` \| `wcag22aa` \| `best-practice` \| `all` | Default `wcag22aa` (WCAG 2.0 to 2.2, A and AA) |
| `minImpact` | `critical` \| `serious` \| `moderate` \| `minor` | Hide violations below this impact |
| `selector` | string | Audit only this part of the page |
| `storageState`, `headers`, `actions`, `routes`, `viewport` | | As `inspect-page` |
| `waitFor`, `waitUntil`, `timeoutMs` | | `waitUntil` default `load`; `timeoutMs` default 60000 |

Each violation has its rule id, impact, WCAG criteria, a help link, up to three
offending elements as verified locators with what to change, and the count of
the rest. The result ends with an `@axe-core/playwright` check to paste into
the spec.

## audit-performance

Measures lab Web Vitals (0.5.0+) in headless Chromium.

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `throttle` | `none` \| `mobile` | `mobile`: 412×823 touch viewport, 4x CPU slowdown, slow 4G (Lighthouse's mobile preset) |
| `cpuSlowdown` | number | Override the CPU factor, 1 to 20 |
| `runs` | number | 1 to 5 loads, median reported (default 1) |
| `budgets` | object | `{ lcpMs, cls, inpMs, tbtMs, fcpMs, ttfbMs, transferKb, requests }`; turns the verdict into pass/fail |
| `settleMs` | number | Observe this long after load (default 1500) |
| `storageState`, `headers`, `actions`, `routes`, `viewport` | | As `inspect-page`; clicks and key presses in `actions` are measured as INP |
| `waitFor`, `waitUntil`, `timeoutMs` | | `waitUntil` default `load`; `timeoutMs` per run, default 60000 |

Returns a table of LCP, CLS, INP (only when `actions` ran), TBT, FCP and TTFB
rated good / needs improvement / poor (or against the budgets), what to fix
(the LCP element and the shifted elements as verified locators, long tasks,
render-blocking requests), transfer size by type, the heaviest requests and
third-party weight, and a Playwright test asserting LCP and CLS budgets.

## suggest-fix

| Argument | Type | Notes |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default 1) |
| `apply` | boolean | Write the fix (default false: diff only) |
| `verify` | boolean | After applying, re-run and revert if still failing (default true) |
| `verifyAllProjects` | boolean | Verify on every configured browser project, revert unless all pass (0.14.0+) |
| `allowExpectationUpdate` | boolean | Allow applying a changed expected text (default false) |
| `candidate` | number | Strict mode violation: which listed match the test meant (0.5.0+) |
| `url`, `storageState`, `headers` | | Heal against a live page instead of the trace snapshot |
| `config`, `timeoutMs` | | As `run-test` |

Python specs (0.13.0+) get the same fixes, written in Python syntax and verified
with pytest.

For a strict mode violation (0.5.0+) it uses the unique locator Playwright
printed for the intended match: the exact-name match with `high` confidence, or
the `candidate` you pass with `medium`; with equal matches and no `candidate`
it lists them and changes nothing.

Returns a unified diff: a locator fix rated `high` or `medium` confidence, or an
expectation update rated `low` that is applied only with
`allowExpectationUpdate: true`. Otherwise it refuses and says the element is most
likely missing.

## get-run-status

| Argument | Type | Notes |
| --- | --- | --- |
| `runId` | string | From `run-test` with `background: true` (default: latest) |
| `waitSeconds` | number | Wait up to this long (max 55) |
| `cancel` | boolean | Stop the run |

## analyze-history

| Argument | Type | Notes |
| --- | --- | --- |
| `view` | `flaky` \| `patterns` \| `slow` \| `trend` \| `commits` \| `test` | Default `flaky`. `slow`, `trend` and `commits` are 0.5.0+ |
| `test` | string | Substring of a test's file or title |
| `lastRuns` | number | Default 30 |
| `limit` | number | Default 15 |

Reads `.playwright-e2e-mcp/history.jsonl`, written by every run
(`PW_MCP_HISTORY=0` disables it). `slow` lists tests by median duration in
passing runs and flags ones that got slower; `trend` shows failed and flaky
executions per day; `commits` names, per failing or flaky test, the first bad
commit after its last passing streak and the last good one.

## audit-tests (0.6.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `testDir` / `filter` | string | Narrow the files |
| `minSeverity` | `low` \| `medium` \| `high` | Default `low` |
| `historyRuns` | number | Default 50 |
| `limit` | number | Findings listed, default 50 |
| `fix` | boolean | Rewrite mechanical findings, re-run touched files, revert on failure |
| `verify` | boolean | Default true |

Rules: `hard-wait`, `sleep`, `non-retrying-assertion`, `missing-await`,
`focused-test` (high); `force-action`, `networkidle`, `element-handle`,
`fragile-selector`, `no-timeout`, `act-before-hydration` (medium; only for server-rendered apps, 0.12.0+); `hardcoded-url`, `serial-mode` (low).
Only `non-retrying-assertion`, `missing-await` and `focused-test` are fixed
mechanically. Files rank by findings weighted by their flaky rate in the history.

## bisect-failure (0.6.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `test` | string | Spec file (required) |
| `grep` | string | Test title; better than `:line` across commits |
| `good` / `bad` | string | Commits or refs; `good` defaults to the newest passing commit in the history, `bad` to HEAD |
| `repeat` | number | Runs per commit (1–10) for intermittent failures |
| `maxSteps` | number | Default 12 |
| `stepTimeoutMs` | number | Default 180000 |

Runs in a temporary git worktree with the current `node_modules` linked in;
untestable commits are skipped. `status` is `found`, `ambiguous`, `max-steps`,
`not-failing` (passes at bad) or `good-fails`.

## save-login (0.7.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Login page (required) |
| `actions` | array | Login steps as in `inspect-page`; fill values may use `{{env:NAME}}` and `{{totp}}` |
| `verify` | object | `url` (page to check, e.g. `/account`), `visible` (locator only a signed-in user sees), `notUrl` (bad if the URL contains it, e.g. `/login`) |
| `name` / `path` | string | Saved to `playwright/.auth/<name>.json` (default `user`) or `path` |
| `totpSecretEnv` | string | Variable holding the authenticator secret (base32 or `otpauth://`) |
| `reuse` | boolean | Keep a saved session that still passes `verify` (default true) |

`status` is `saved`, `valid` (reused, nothing typed) or `failed` (no file written).
Only `E2E_*`, `TEST_*`, `PW_*`, `PLAYWRIGHT_*`, `LOGIN_*` and names in
`PW_MCP_LOGIN_ENV` can be read through `{{env:…}}`.

## check-test-change (0.7.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `base` | string | Git ref (default `HEAD`: the uncommitted changes; `origin/main` for the branch) |
| `files` | string[] | Only these files |
| `file` + `after` | string | Check a proposed full file content before writing it |
| `runtime` | boolean | 0.12.0+: also run old and new version of each changed TS/JS spec and compare the assertions that ran per test |

`status` is `OK`, `WARN` or `BLOCK`; `ok` is false only on BLOCK. BLOCK: fewer
assertions in a test, a removed or skipped test, `.only`, a deleted spec, an
assertion moved under an `if` / `&&` / `?`, and (runtime) fewer assertions
executed. WARN: `expect.soft`, a weaker matcher, `waitForTimeout`, `force: true`,
a swallowed error, an early `return`, a raised timeout, retries or screenshot
tolerance. Since 0.12.0 it also reads pytest files (`test_*.py`).

## check-mocks (0.12.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `baseUrl` | string | Live server for relative mock URLs (default: `use.baseURL` from the config) |
| `urls` | object | Real URL for each wildcard/regex mock: `{ "**/api/items/*": "/api/items/1" }` |
| `headers` | object | Headers for the live calls; write `{{env:E2E_API_TOKEN}}`, never a token |
| `filter` | string | Only test files whose path contains this text |

Finds `route.fulfill` JSON bodies (TS/JS and pytest) and `routeFromHAR` files, GETs
each mocked endpoint and compares JSON shapes. `status` is `OK`, `DRIFT` or
`NOTHING CHECKED`. High: `missing-field`, `type-changed`, `endpoint-gone`,
`not-json`. Medium: `now-null`, `status-changed`, `server-error`. Low: `new-field`.
Write mocks (POST…), error mocks and runtime-built bodies are skipped with a reason.
On DRIFT, update the mock to the live shape and run the tests: the app code that
reads the changed field is what breaks in production.

## quarantine (0.7.0+)

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string | `list` (default), `add`, `remove` |
| `test` | string | `'file › title'`; or `file` + `title`; or `index` (last run's failure) |
| `owner` / `reason` | string | Required for `add` |
| `days` | number | 1–90, default 14 |

Stored in `playwright-quarantine.json` (commit it). A quarantined, unexpired
failure is listed under 🧊 and does not fail `run-test` or `ci`; `run.quarantined`
counts them. Expired entries block again.
