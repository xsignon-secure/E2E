/**
 * Python support: run pytest-playwright suites through the same tools.
 *
 * A Python project has no node_modules and no playwright.config, so the
 * Node runner cannot touch it. This module runs `python -m pytest` instead
 * and turns its results into the same RunTestResult the Node runner
 * returns, so run-test, get-failure (traces included), list-tests,
 * analyze-history and the ci command work unchanged.
 *
 * Results come from a small pytest plugin the server writes to its temp
 * directory and loads with `-p` (nothing is installed in the project). It
 * appends one JSON line per test as the test finishes: node id, absolute
 * file and line, outcome, the full failure text, the crash location and
 * the trace files pytest-playwright kept. Because lines are written as
 * tests end, a run that is killed still reports the tests that finished.
 *
 * The project's own Python is used: PW_MCP_PYTHON, else a virtualenv in
 * the project (.venv, venv, env), else python3 / python on PATH.
 */

import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';
import type {
  BrowserName,
  DiscoveredTest,
  ErrorKind,
  ListTestsResult,
  ReportStats,
  RunTestOptions,
  RunTestResult,
  TestFailure,
  TestOutcome,
  TestStatus,
} from '../types/index.js';
import { childEnv, runProcess } from './playwright-runner.js';
import { classifyFailure, emptyStats, stripAnsi } from './report-parser.js';
import {
  hasOptionLikeSegment,
  isAbsolutePath,
  isPathInside,
  normalizePath,
  relativeToRoot,
  tempFilePath,
  toNativePath,
} from './path-utils.js';
import { logger } from './logger.js';

/** Environment variable naming the JSONL file the plugin appends to. */
export const PYTEST_RESULTS_ENV = 'PW_MCP_PYTEST_RESULTS';
const PLUGIN_MODULE = 'pw_mcp_pytest_results';
const DEFAULT_TIMEOUT_MS = 600_000;
const TAIL_CHARS = 8_000;
const MAX_FAILURES = 50;

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

async function fileText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the folder is a pytest project, and which file says so:
 * pytest.ini, a [tool.pytest…] table in pyproject.toml, [tool:pytest] in
 * setup.cfg, [pytest] in tox.ini, or a conftest.py at the root or in tests/.
 */
export async function detectPytestProject(root: string): Promise<{ marker: string } | null> {
  if (await isFile(path.join(root, 'pytest.ini'))) return { marker: 'pytest.ini' };
  const pyproject = await fileText(path.join(root, 'pyproject.toml'));
  if (pyproject !== null && /^\s*\[tool\.pytest(?:\.ini_options)?\]/m.test(pyproject)) return { marker: 'pyproject.toml' };
  const setupCfg = await fileText(path.join(root, 'setup.cfg'));
  if (setupCfg !== null && /^\s*\[tool:pytest\]/m.test(setupCfg)) return { marker: 'setup.cfg' };
  const tox = await fileText(path.join(root, 'tox.ini'));
  if (tox !== null && /^\s*\[pytest\]/m.test(tox)) return { marker: 'tox.ini' };
  for (const conftest of ['conftest.py', 'tests/conftest.py']) {
    if (await isFile(path.join(root, conftest))) return { marker: conftest };
  }
  return null;
}

/** The Python to run: PW_MCP_PYTHON, a project virtualenv, or python3 / python. */
export async function resolvePython(root: string): Promise<string> {
  const fromEnv = process.env.PW_MCP_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const windows = process.platform === 'win32';
  for (const venv of ['.venv', 'venv', 'env']) {
    const candidate = windows ? path.join(root, venv, 'Scripts', 'python.exe') : path.join(root, venv, 'bin', 'python');
    if (await isFile(candidate)) return candidate;
  }
  return windows ? 'python' : 'python3';
}

/* ------------------------------------------------------------------ */
/* The results plugin                                                  */
/* ------------------------------------------------------------------ */

/**
 * Runs inside the project's pytest. One line per test, written at its last
 * phase (teardown), with the first failing phase's details. Only the
 * standard library is required; the trace lookup uses pytest-playwright's
 * own slugify so folder names match exactly.
 */
const PLUGIN_SOURCE = `import json
import os

_path = os.environ.get("${PYTEST_RESULTS_ENV}")
_state = {}


def _write(obj):
    if not _path:
        return
    try:
        with open(_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(obj) + "\\n")
    except OSError:
        pass


def _trace_files(item):
    try:
        from slugify import slugify
        output = item.config.getoption("--output")
    except Exception:
        return []
    folder = slugify(item.nodeid)
    retry = getattr(item, "execution_count", 1) - 1
    if retry > 0:
        folder += "-retry" + str(retry)
    if len(folder) >= 256:
        import hashlib
        folder = folder[:100] + "-" + hashlib.sha256(folder.encode()).hexdigest()[:7] + "-" + folder[-100:]
    base = os.path.join(os.path.abspath(output), folder)
    try:
        return [os.path.join(base, name) for name in sorted(os.listdir(base)) if name.startswith("trace") and name.endswith(".zip")]
    except OSError:
        return []


def pytest_collection_finish(session):
    _write({"event": "collected", "count": len(session.items), "rootdir": str(session.config.rootpath)})


def pytest_runtest_logreport(report):
    entry = _state.setdefault(report.nodeid, {"outcome": "passed", "duration": 0.0})
    entry["duration"] += getattr(report, "duration", 0.0) or 0.0
    if report.when == "call" and report.passed and hasattr(report, "wasxfail"):
        entry["outcome"] = "xpassed"
    if report.failed and entry["outcome"] not in ("failed", "error"):
        entry["outcome"] = "failed" if report.when == "call" else "error"
        entry["when"] = report.when
        entry["longrepr"] = (report.longreprtext or "")[:12000]
        crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
        if crash is not None:
            entry["crash"] = {"path": str(crash.path), "line": crash.lineno, "message": (crash.message or "")[:4000]}
    elif report.skipped and entry["outcome"] == "passed":
        entry["outcome"] = "xfailed" if hasattr(report, "wasxfail") else "skipped"
        if report.longrepr and isinstance(report.longrepr, tuple) and len(report.longrepr) == 3:
            entry["reason"] = str(report.longrepr[2])[:300]


def pytest_runtest_logfinish(nodeid, location):
    entry = _state.pop(nodeid, None)
    if entry is None:
        return
    entry["nodeid"] = nodeid
    entry["file"] = location[0]
    entry["line"] = location[1]
    _write(entry)


def pytest_runtest_teardown(item, nextitem):
    entry = _state.get(item.nodeid)
    if entry is not None:
        entry["path"] = str(item.path)
        entry["traces"] = []


def pytest_runtest_makereport(item, call):
    if call.when == "teardown":
        entry = _state.get(item.nodeid)
        if entry is not None:
            entry["traces"] = _trace_files(item)


def pytest_sessionfinish(session, exitstatus):
    _write({"event": "finished", "exitstatus": int(exitstatus)})
`;

let pluginDir: Promise<string> | undefined;

/** Folder holding the plugin module, added to PYTHONPATH for the run. */
export function pytestPluginDir(): Promise<string> {
  if (!pluginDir) {
    const dir = tempFilePath('pw-mcp-pytest-plugin', '');
    pluginDir = mkdir(dir, { recursive: true })
      .then(() => writeFile(path.join(dir, `${PLUGIN_MODULE}.py`), PLUGIN_SOURCE, 'utf8'))
      .then(
        () => dir,
        (err: unknown) => {
          pluginDir = undefined;
          throw err;
        },
      );
  }
  return pluginDir;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

interface PytestLine {
  nodeid: string;
  /** Path of the test file, absolute when the plugin knew it. */
  path?: string;
  /** location[0]: relative to pytest's rootdir. */
  file?: string;
  /** 0-based, as pytest reports it. */
  line?: number;
  outcome: string;
  when?: string;
  duration?: number;
  longrepr?: string;
  crash?: { path?: string; line?: number; message?: string };
  reason?: string;
  traces?: string[];
}

export interface ParsedPytestResults {
  stats: ReportStats;
  failures: TestFailure[];
  failuresTruncated: boolean;
  outcomes: TestOutcome[];
  tests: DiscoveredTest[];
  collected?: number;
  exitStatus?: number;
}

const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

/** Split a node id into file, readable title and browser project. */
export function describeNodeId(nodeid: string): { file: string; title: string; project?: string } {
  const [file, ...rest] = nodeid.split('::');
  let project: string | undefined;
  const parts = rest.map((part, i) => {
    if (i !== rest.length - 1) return part;
    const param = /^(.*)\[(.*)\]$/.exec(part);
    if (!param) return part;
    const values = param[2].split('-');
    if (BROWSERS.has(values[0])) {
      project = values[0];
      const others = values.slice(1).join('-');
      return others ? `${param[1]}[${others}]` : param[1];
    }
    return part;
  });
  return { file, title: [path.posix.basename(file), ...parts].join(' › '), ...(project ? { project } : {}) };
}

function asLine(value: unknown): PytestLine | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.nodeid !== 'string' || typeof entry.outcome !== 'string') return null;
  return entry as unknown as PytestLine;
}

/** Map a pytest outcome onto the server's statuses (xfail counts as skipped, xpass as failed). */
function statusOf(outcome: string, longrepr: string | undefined): TestStatus {
  switch (outcome) {
    case 'passed':
      return 'passed';
    case 'skipped':
    case 'xfailed':
      return 'skipped';
    case 'failed':
    case 'error':
    case 'xpassed':
      // pytest-timeout's whole-test limit; a Playwright action timeout is a plain failure, as in Node.
      return /^E\s+Failed: Timeout >/m.test(longrepr ?? '') ? 'timedOut' : 'failed';
    default:
      return 'unknown';
  }
}

/**
 * The failure's code frame: the source lines pytest prints with `>` at the
 * failing line, up to the first `E` line that follows.
 */
export function pytestCodeFrame(longrepr: string): string | undefined {
  const lines = longrepr.split('\n');
  const marker = lines.findIndex((line) => /^>\s/.test(line));
  if (marker < 0) return undefined;
  let start = marker;
  while (start > 0 && marker - start < 6 && lines[start - 1].trim() !== '' && !/^(?:_{3,}|E\s)/.test(lines[start - 1])) start -= 1;
  let end = marker + 1;
  while (end < lines.length && end - marker < 8 && /^E\s/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/**
 * The test file's own line in a traceback: pytest prints `path:LINE: Error`
 * for each frame, and the crash itself is often inside Playwright, so take
 * the last frame that is in the test file.
 */
export function testFileLine(longrepr: string, file: string): number | undefined {
  const want = normalizePath(file);
  let found: number | undefined;
  for (const match of longrepr.matchAll(/^(\S[^\n]*?):(\d+):(?: |$)/gm)) {
    const at = normalizePath(match[1]);
    if (at === want || at.endsWith(`/${want}`) || want.endsWith(`/${at}`)) found = Number(match[2]);
  }
  return found;
}

/**
 * The traceback without the frames inside Playwright and other libraries:
 * pytest separates frames with \`_ _ _\` lines; keep the test's own frames
 * (those that mention the test file) and the final \`E\` lines.
 */
export function shortTraceback(longrepr: string, max = 6_000): string {
  const chunks = longrepr.split(/^(?:_ ){10,}_?\s*$/m);
  if (chunks.length === 1) return longrepr.slice(0, max);
  const own = chunks.filter((chunk, i) => i === 0 || /^\S[^\n]*\.py:\d+:(?: |$)/m.test(chunk) && !/site-packages|dist-packages/.test(chunk.match(/^(\S[^\n]*?\.py):\d+:(?: |$)/m)?.[1] ?? ''));
  const errors = chunks.at(-1)!.split('\n').filter((l) => /^E\s/.test(l) || /^\S[^\n]*\.py:\d+:(?: |$)/.test(l));
  const dropped = chunks.length - own.length;
  return [...own.map((c) => c.trim()), dropped > 0 ? `… ${dropped} frame${dropped === 1 ? '' : 's'} inside libraries …` : '', ...errors]
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
}

/** Expected / actual values from a Playwright Python assertion message. */
export function expectedActual(message: string): { expected?: string; actual?: string } {
  const expected =
    /^\s*Expected (?:value|pattern|string|substring)?:?\s*(.+)$/im.exec(message)?.[1]?.trim() ??
    /expected to (?:have|be|contain) [\w ]+? '(.*)'$/im.exec(message)?.[1];
  const actual = /^\s*(?:Actual value|Received(?: string| value)?):\s*(.+)$/im.exec(message)?.[1]?.trim();
  const fromAssert = /assert (.+?) == (.+)$/m.exec(message);
  return {
    ...(expected ? { expected } : fromAssert ? { expected: fromAssert[2].trim() } : {}),
    ...(actual ? { actual } : fromAssert ? { actual: fromAssert[1].trim() } : {}),
  };
}

/** The failure's own message: pytest's crash message, else the E lines of the report. */
function failureMessage(line: PytestLine): string {
  const crash = line.crash?.message?.trim();
  if (crash) return stripAnsi(crash);
  const eLines = (line.longrepr ?? '')
    .split('\n')
    .filter((l) => /^E\s/.test(l))
    .map((l) => l.replace(/^E\s{0,3}/, ''));
  if (eLines.length > 0) return stripAnsi(eLines.join('\n')).trim();
  const last = (line.longrepr ?? '').trim().split('\n').at(-1);
  return stripAnsi(last ?? '') || (line.when && line.when !== 'call' ? `Error in test ${line.when}.` : 'Test failed.');
}

/**
 * Turn the plugin's JSONL into failures, outcomes and stats. Paths become
 * project-relative; malformed lines (a write cut off by a kill) are skipped.
 */
export function parsePytestResults(raw: string, root: string, maxFailures = MAX_FAILURES): ParsedPytestResults {
  const localRoot = normalizePath(root);
  const stats = emptyStats();
  const failures: TestFailure[] = [];
  const outcomes: TestOutcome[] = [];
  const tests: DiscoveredTest[] = [];
  let collected: number | undefined;
  let exitStatus: number | undefined;
  let rootdir = localRoot;
  let failing = 0;

  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const event = parsed as Record<string, unknown>;
    if (event.event === 'collected') {
      if (typeof event.count === 'number') collected = event.count;
      if (typeof event.rootdir === 'string') rootdir = normalizePath(event.rootdir);
      continue;
    }
    if (event.event === 'finished') {
      if (typeof event.exitstatus === 'number') exitStatus = event.exitstatus;
      continue;
    }
    const line = asLine(parsed);
    if (!line) continue;

    const described = describeNodeId(line.nodeid);
    const absolute = line.path
      ? normalizePath(line.path)
      : normalizePath(path.join(rootdir, line.file ?? described.file));
    const file = isPathInside(absolute, localRoot) ? relativeToRoot(localRoot, absolute) : normalizePath(line.file ?? described.file);
    const lineNo = typeof line.line === 'number' ? line.line + 1 : undefined;
    const status = statusOf(line.outcome, line.longrepr);
    const durationMs = typeof line.duration === 'number' ? Math.round(line.duration * 1000) : undefined;
    stats.duration += durationMs ?? 0;
    tests.push({ file, title: described.title, ...(lineNo ? { line: lineNo } : {}), ...(described.project ? { projects: [described.project] } : {}) });

    const outcome: TestOutcome = { file, ...(lineNo ? { line: lineNo } : {}), title: described.title, ...(described.project ? { project: described.project } : {}), status, ...(durationMs !== undefined ? { durationMs } : {}) };
    if (status === 'passed') stats.expected += 1;
    else if (status === 'skipped') stats.skipped += 1;
    else if (status === 'failed' || status === 'timedOut') {
      stats.unexpected += 1;
      failing += 1;
      const message = line.outcome === 'xpassed' ? 'Test was expected to fail (xfail strict) but passed.' : failureMessage(line);
      const longrepr = stripAnsi(line.longrepr ?? '');
      const failureKind = classifyFailure(`${message}\n${longrepr}`, status);
      outcome.message = (message.split('\n')[0] ?? '').slice(0, 200) || undefined;
      outcome.failureKind = failureKind;
      if (failures.length < maxFailures) {
        // pytest's crash location is the innermost frame; prefer the test file's own line.
        const crashPath = line.crash?.path ? normalizePath(line.crash.path) : undefined;
        const crashLine =
          crashPath && crashPath === absolute && typeof line.crash?.line === 'number' ? line.crash.line : testFileLine(longrepr, line.file ?? described.file);
        const trace = (line.traces ?? []).map((t) => normalizePath(t)).find((t) => isAbsolutePath(t));
        failures.push({
          file,
          line: crashLine ?? lineNo,
          title: described.title,
          ...(described.project ? { project: described.project } : {}),
          status,
          failureKind,
          message,
          stack: shortTraceback(longrepr) || undefined,
          codeframe: pytestCodeFrame(longrepr),
          ...expectedActual(message),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(trace ? { tracePath: trace } : {}),
        });
      }
    }
    outcomes.push(outcome);
  }

  return { stats, failures, failuresTruncated: failing > failures.length, outcomes, tests, collected, exitStatus };
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn `file.py:LINE` into the node id of the test defined at or above that
 * line (`file.py::TestCart::test_add`), so get-failure's re-run hints work
 * for pytest too. `file.py::name` and plain paths pass through.
 */
export function nodeIdForLine(relativeFile: string, source: string, line: number): string {
  const lines = source.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i -= 1) {
    const def = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(lines[i]);
    if (!def) continue;
    const indent = def[1].length;
    if (indent === 0) return `${relativeFile}::${def[2]}`;
    for (let j = i - 1; j >= 0; j -= 1) {
      const cls = /^(\s*)class\s+(\w+)/.exec(lines[j]);
      if (cls && cls[1].length < indent) return `${relativeFile}::${cls[2]}::${def[2]}`;
    }
    return `${relativeFile}::${def[2]}`;
  }
  return relativeFile;
}

async function pytestTarget(file: string, root: string): Promise<string> {
  const absolute = normalizePath(isAbsolutePath(file) ? file : path.join(root, file));
  const nodeSuffix = absolute.indexOf('::');
  const [base, suffix] = nodeSuffix >= 0 ? [absolute.slice(0, nodeSuffix), absolute.slice(nodeSuffix)] : [absolute, ''];
  const lineMatch = suffix === '' ? /^(.*\.py):(\d+)(?::\d+)?$/.exec(base) : null;
  const filePath = lineMatch ? lineMatch[1] : base;
  if (!isPathInside(filePath, root)) {
    throw new PlaywrightMcpError(`Test path "${file}" is outside the project root`, 'INVALID_PATH', {
      hint: `Only test paths inside ${root} are allowed.`,
    });
  }
  const relative = relativeToRoot(root, filePath);
  if (hasOptionLikeSegment(relative) || /^-/.test(suffix.replace(/^::/, ''))) {
    throw new PlaywrightMcpError(`Test path "${file}" has a segment starting with "-"`, 'INVALID_PATH', {
      hint: 'Rename the file or folder so no path segment starts with "-".',
    });
  }
  if (lineMatch) {
    const source = await fileText(filePath);
    return source === null ? relative : nodeIdForLine(relative, source, Number(lineMatch[2]));
  }
  return `${relative}${suffix}`;
}

/** Flags the caller may pass through `args` to pytest. */
const ALLOWED_ARGS: ReadonlyArray<RegExp> = [
  /^-x$/,
  /^--exitfirst$/,
  /^--maxfail=\d{1,4}$/,
  /^--headed$/,
  /^--slowmo=\d{1,6}$/,
  /^--browser-channel=(?:chrome|chrome-beta|msedge|msedge-beta)$/,
  /^--device=[\w .()+-]{2,60}$/,
  /^-m=[\w ()]{1,200}$/,
  /^--reruns=\d{1,2}$/,
  /^-n=(?:auto|\d{1,3})$/,
];

function checkedArgs(extra: string[] | undefined): string[] {
  const out: string[] = [];
  for (const arg of extra ?? []) {
    if (!ALLOWED_ARGS.some((re) => re.test(arg))) {
      throw new PlaywrightMcpError(`pytest argument "${arg}" is not allowed`, 'INVALID_INPUT', {
        hint: 'Allowed: -x, --maxfail=N, --headed, --slowmo=MS, --browser-channel=…, --device=…, -m=EXPR, --reruns=N (pytest-rerunfailures), -n=N (pytest-xdist).',
      });
    }
    // pytest's -m and -n take a separate value.
    if (arg.startsWith('-m=') || arg.startsWith('-n=')) out.push(arg.slice(0, 2), arg.slice(3));
    else out.push(arg);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function tail(text: string, limit = TAIL_CHARS): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

/** Run-level problems pytest reports on stderr/stdout instead of per test. */
export function diagnosePytestOutput(text: string, exitCode: number | null): { errorKind: ErrorKind; errorMessage: string; hint: string } | null {
  if (/No module named pytest\b/.test(text)) {
    return { errorKind: 'NO_PLAYWRIGHT', errorMessage: 'pytest is not installed for this Python.', hint: 'Run: pip install pytest-playwright && playwright install chromium (or set PW_MCP_PYTHON to the Python of your virtualenv).' };
  }
  if (/unrecognized arguments: .*--(?:tracing|browser|output)\b/.test(text)) {
    return { errorKind: 'NO_PLAYWRIGHT', errorMessage: 'pytest-playwright is not installed for this Python.', hint: 'Run: pip install pytest-playwright && playwright install chromium.' };
  }
  if (/Executable doesn't exist at|playwright install/.test(text) && /BrowserType\.launch/.test(text)) {
    return { errorKind: 'NO_PLAYWRIGHT', errorMessage: 'The Playwright browsers are not installed for this Python.', hint: 'Run: playwright install chromium (inside the same virtualenv).' };
  }
  if (exitCode === 4) {
    const usage = /error: (.+)/.exec(text)?.[1] ?? 'pytest rejected the command line.';
    return { errorKind: 'INVALID_INPUT', errorMessage: usage, hint: 'Check the test paths and the args you passed.' };
  }
  if (exitCode === 5) {
    return { errorKind: 'INVALID_PATH', errorMessage: 'pytest collected no tests.', hint: 'Check the test paths (and grep, which becomes pytest -k). Test files must match test_*.py or *_test.py.' };
  }
  if (/^E\s+(?:SyntaxError|IndentationError)|ERROR collecting/m.test(text)) {
    return { errorKind: 'SYNTAX_ERROR', errorMessage: 'pytest could not import a test file.', hint: 'See the collection error in the output below and fix the import or syntax error.' };
  }
  return null;
}

function browserArg(browser: BrowserName | undefined, project: string | undefined): string[] {
  const wanted = project ?? browser;
  if (!wanted) return [];
  if (!BROWSERS.has(wanted)) {
    throw new PlaywrightMcpError(`"${wanted}" is not a pytest-playwright browser`, 'INVALID_INPUT', { hint: 'Use chromium, firefox or webkit.' });
  }
  return ['--browser', wanted];
}

/** Run a pytest-playwright suite and return the same result shape as the Node runner. */
export async function runPytest(options: RunTestOptions): Promise<RunTestResult> {
  const root = normalizePath(options.projectRoot);
  if (options.signal?.aborted) {
    throw new PlaywrightMcpError('Request cancelled before the run started', 'CLIENT_DISCONNECT', { hint: 'The MCP client disconnected.' });
  }
  for (const [name, value] of [['repeatEach', options.repeatEach], ['shuffleSeed', options.shuffleSeed], ['fullyParallel', options.fullyParallel]] as const) {
    if (value !== undefined && value !== false && !(name === 'repeatEach' && value === 1)) {
      throw new PlaywrightMcpError(`${name} is not supported for pytest projects yet`, 'INVALID_INPUT', {
        hint: 'Repeat runs with pytest-repeat (`--count`) yourself, or re-run the test with run-test a few times.',
      });
    }
  }

  const python = await resolvePython(root);
  const targets: string[] = [];
  for (const file of options.testFiles ?? []) targets.push(await pytestTarget(file, root));
  const resultsPath = tempFilePath('pw-pytest', '.jsonl');
  const args = ['-m', 'pytest', '-p', PLUGIN_MODULE, '-q', '-rN', '--color=no'];
  args.push('--tracing', 'retain-on-failure');
  args.push(...browserArg(options.browser, options.project));
  if (options.headed) args.push('--headed');
  if (options.grep) {
    if (/[\x00-\x1f]/.test(options.grep) || options.grep.length > 500) {
      throw new PlaywrightMcpError('grep is not a valid pytest -k expression', 'INVALID_INPUT');
    }
    args.push('-k', options.grep);
  }
  if (options.lastFailed) args.push('--last-failed');
  if (options.changed !== undefined && options.changed !== false) {
    throw new PlaywrightMcpError('changed is not available for pytest projects', 'INVALID_INPUT', {
      hint: 'pytest has no import-aware --only-changed. Pass the test files you changed, or use lastFailed: true.',
    });
  }
  const retries = options.retries ?? 0;
  if (retries > 0) args.push(`--reruns=${Math.min(retries, 10)}`);
  args.push(...checkedArgs(options.extraArgs));
  args.push('--', ...targets);

  const plugin = await pytestPluginDir();
  const pythonPath = [toNativePath(plugin), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const env = childEnv({
    [PYTEST_RESULTS_ENV]: toNativePath(resultsPath),
    PYTHONPATH: pythonPath,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PY_COLORS: '0',
  });
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 3_600_000);
  const startedAt = Date.now();
  logger.debug('Starting pytest run', { python, args: args.join(' '), cwd: root });
  const outcome = await runProcess(python, args, { cwd: root, env, timeoutMs, signal: options.signal });
  const durationMs = Date.now() - startedAt;

  const raw = (await fileText(resultsPath)) ?? '';
  await rm(resultsPath, { force: true }).catch(() => undefined);
  const parsed = parsePytestResults(raw, root);
  const finished = parsed.exitStatus !== undefined;
  const combined = `${outcome.stderr}\n${outcome.stdout}`;

  let errorKind: ErrorKind | undefined;
  let errorMessage: string | undefined;
  let hint: string | undefined;
  if (outcome.spawnError) {
    errorKind = outcome.spawnError.code === 'ENOENT' ? 'NO_PLAYWRIGHT' : 'SPAWN_FAILED';
    errorMessage = outcome.spawnError.code === 'ENOENT' ? `Python was not found (${python}).` : outcome.spawnError.message;
    hint = 'Install Python 3 with pytest-playwright, or set PW_MCP_PYTHON to the Python of your virtualenv.';
  } else if (outcome.aborted) {
    errorKind = 'CLIENT_DISCONNECT';
    errorMessage = 'Run aborted because the MCP client disconnected.';
    hint = 'Child processes and browsers were terminated.';
  } else if (outcome.timedOut) {
    errorKind = 'TIMEOUT';
    errorMessage = `Run exceeded the ${timeoutMs}ms limit and was killed.`;
    hint = 'The tests that finished are shown below. Raise timeoutMs or run fewer tests.';
  } else {
    const diagnosis = parsed.failures.length === 0 || !finished ? diagnosePytestOutput(combined, outcome.code) : null;
    if (diagnosis) ({ errorKind, errorMessage, hint } = diagnosis);
    else if (!finished && outcome.code !== 0) {
      errorKind = 'REPORT_MISSING';
      errorMessage = 'pytest stopped before the session finished.';
      hint = 'The tests that finished are shown below; see the output for why pytest stopped.';
    }
  }

  const ok = outcome.code === 0 && !outcome.timedOut && !outcome.aborted && !outcome.spawnError;
  return {
    ok,
    exitCode: outcome.code,
    signalName: outcome.signalName,
    durationMs,
    timedOut: outcome.timedOut,
    killed: outcome.timedOut || outcome.aborted,
    partial: !finished,
    stats: parsed.collected !== undefined || parsed.outcomes.length > 0 ? { ...parsed.stats, duration: durationMs } : null,
    outcomes: parsed.outcomes,
    failures: parsed.failures,
    failuresTruncated: parsed.failuresTruncated,
    stdoutTail: tail(outcome.stdout),
    stderrTail: tail(outcome.stderr),
    truncatedOutput: outcome.stdout.length + outcome.stderr.length > TAIL_CHARS,
    // The command a person would type: without the server's own plugin.
    command: ['python', ...args.filter((a, i) => !(a === '-p' && args[i + 1] === PLUGIN_MODULE) && a !== PLUGIN_MODULE && !(a === '--' && targets.length === 0))].join(' '),
    lastFailed: options.lastFailed === true,
    errorKind,
    errorMessage,
    hint,
  };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

const TEST_FILE = /^(?:test_.*|.*_test)\.py$/;

async function scanPythonTests(root: string, dir: string, out: DiscoveredTest[], depth = 0): Promise<void> {
  if (depth > 8 || out.length > 5_000) return;
  const { readdir } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'venv', 'env', 'site-packages', 'test-results'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await scanPythonTests(root, full, out, depth + 1);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      const source = await fileText(full);
      if (source === null) continue;
      const file = relativeToRoot(root, normalizePath(full));
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (/^\s*(?:async\s+)?def\s+test\w*\s*\(/.test(lines[i])) {
          const id = nodeIdForLine(file, source, i + 1);
          out.push({ file, line: i + 1, title: describeNodeId(id).title });
        }
      }
    }
  }
}

/**
 * List a pytest project's tests: `pytest --collect-only -q` when allowed to
 * run project code, a scan of test_*.py / *_test.py files otherwise (or
 * when collection fails, with the reason).
 */
export async function listPytestTests(options: { projectRoot: string; filter?: string; limit?: number; signal?: AbortSignal; noSpawn?: boolean }): Promise<ListTestsResult> {
  const root = normalizePath(options.projectRoot);
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);
  let tests: DiscoveredTest[] = [];
  let source: ListTestsResult['source'] = 'file-scan';
  let error: ListTestsResult['error'];
  if (!options.noSpawn) {
    const python = await resolvePython(root);
    const outcome = await runProcess(python, ['-m', 'pytest', '--collect-only', '-q', '--color=no', '-p', 'no:cacheprovider'], {
      cwd: root,
      env: childEnv({ PYTHONDONTWRITEBYTECODE: '1', PY_COLORS: '0' }),
      timeoutMs: 120_000,
      signal: options.signal,
    });
    const ids = outcome.stdout.split('\n').map((l) => l.trim()).filter((l) => l.includes('::') && !l.startsWith('<'));
    if (outcome.code === 0 && ids.length > 0) {
      source = 'pytest-collect';
      const seen = new Map<string, DiscoveredTest>();
      for (const id of ids) {
        const d = describeNodeId(id);
        const key = `${d.file}\u0000${d.title}`;
        const known = seen.get(key);
        if (known) {
          if (d.project && !known.projects?.includes(d.project)) known.projects = [...(known.projects ?? []), d.project];
          continue;
        }
        seen.set(key, { file: d.file, title: d.title, ...(d.project ? { projects: [d.project] } : {}) });
      }
      tests = [...seen.values()];
    } else {
      const diagnosis = diagnosePytestOutput(`${outcome.stderr}\n${outcome.stdout}`, outcome.code);
      error = diagnosis
        ? { kind: diagnosis.errorKind, message: diagnosis.errorMessage, hint: diagnosis.hint }
        : { kind: outcome.spawnError ? 'NO_PLAYWRIGHT' : 'UNKNOWN', message: outcome.spawnError ? `Python was not found (${python}).` : 'pytest --collect-only failed.', hint: 'Set PW_MCP_PYTHON to the Python of your virtualenv.' };
    }
  }
  if (source === 'file-scan') await scanPythonTests(root, root, tests);
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    tests = tests.filter((t) => `${t.file} › ${t.title}`.toLowerCase().includes(needle));
  }
  return { tests: tests.slice(0, limit), total: tests.length, truncated: tests.length > limit, testDir: null, source, ...(error ? { error } : {}) };
}
