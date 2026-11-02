/**
 * Python support: pytest project detection, node ids, the results plugin's
 * JSONL turned into failures, and (when a Python with pytest-playwright is
 * available through PW_MCP_PYTHON) a live run through run-test, get-failure
 * and list-tests.
 */

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeNodeId,
  detectPytestProject,
  diagnosePytestOutput,
  expectedActual,
  nodeIdForLine,
  parsePytestResults,
  pytestCodeFrame,
  resolvePython,
  runPytest,
  shortTraceback,
  testFileLine,
} from '../dist/utils/pytest-runner.js';
import { createToolStore, sanitizeTestPathArgument, testPathExists } from '../dist/tools/shared.js';
import { runTestTool } from '../dist/tools/run-test.js';
import { getFailureTool } from '../dist/tools/get-failure.js';
import { listTestsTool } from '../dist/tools/list-tests.js';
import { suggestFixTool } from '../dist/tools/suggest-fix.js';
import { diagnoseFlakyTool } from '../dist/tools/diagnose-flaky.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const ctxFor = (root) => ({ logger: silent, store: createToolStore(), projectRoot: root });
const textOf = (response) => response.content.map((c) => c.text).join('\n');
const tmpRoot = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-pytest-')));

/* ---------------- detection ---------------- */

test('a pytest project is recognised by its config or conftest', async () => {
  const cases = [
    ['pytest.ini', '[pytest]\n', 'pytest.ini'],
    ['pyproject.toml', '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n', 'pyproject.toml'],
    ['setup.cfg', '[tool:pytest]\ntestpaths = tests\n', 'setup.cfg'],
    ['tox.ini', '[tox]\n\n[pytest]\n', 'tox.ini'],
    ['tests/conftest.py', 'import pytest\n', 'tests/conftest.py'],
  ];
  for (const [file, body, marker] of cases) {
    const root = tmpRoot();
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
    assert.deepEqual(await detectPytestProject(root), { marker }, file);
  }
  const plain = tmpRoot();
  writeFileSync(path.join(plain, 'pyproject.toml'), '[project]\nname = "not-pytest"\n');
  assert.equal(await detectPytestProject(plain), null);
});

test('the project virtualenv wins over python3 on PATH, PW_MCP_PYTHON over both', async () => {
  const root = tmpRoot();
  const saved = process.env.PW_MCP_PYTHON;
  delete process.env.PW_MCP_PYTHON;
  try {
    assert.equal(await resolvePython(root), process.platform === 'win32' ? 'python' : 'python3');
    const bin = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '');
    assert.equal(await resolvePython(root), bin);
    process.env.PW_MCP_PYTHON = '/opt/py/bin/python';
    assert.equal(await resolvePython(root), '/opt/py/bin/python');
  } finally {
    if (saved === undefined) delete process.env.PW_MCP_PYTHON;
    else process.env.PW_MCP_PYTHON = saved;
  }
});

/* ---------------- node ids ---------------- */

test('node ids become readable titles with the browser as the project', () => {
  assert.deepEqual(describeNodeId('tests/test_cart.py::test_add[chromium]'), { file: 'tests/test_cart.py', title: 'test_cart.py › test_add', project: 'chromium' });
  assert.deepEqual(describeNodeId('tests/test_cart.py::TestCart::test_qty[webkit-3]'), { file: 'tests/test_cart.py', title: 'test_cart.py › TestCart › test_qty[3]', project: 'webkit' });
  assert.deepEqual(describeNodeId('test_x.py::test_data[a-b]'), { file: 'test_x.py', title: 'test_x.py › test_data[a-b]' });
});

test('file:line runs the test defined at that line', () => {
  const source = ['import pytest', '', 'def test_one(page):', '    page.goto("/")', '', 'class TestCart:', '    def test_add(self, page):', '        page.click("#add")', '', 'async def test_async(page):', '    pass'].join('\n');
  assert.equal(nodeIdForLine('tests/test_c.py', source, 4), 'tests/test_c.py::test_one');
  assert.equal(nodeIdForLine('tests/test_c.py', source, 8), 'tests/test_c.py::TestCart::test_add');
  assert.equal(nodeIdForLine('tests/test_c.py', source, 11), 'tests/test_c.py::test_async');
  assert.equal(nodeIdForLine('tests/test_c.py', source, 1), 'tests/test_c.py');
});

test('test paths may carry a pytest node id', async () => {
  const root = tmpRoot();
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests', 'test_a.py'), 'def test_x(): pass\n');
  const arg = sanitizeTestPathArgument('tests/test_a.py::test_x[chromium]', root);
  assert.equal(arg, `${root}/tests/test_a.py::test_x[chromium]`.replace(/\\/g, '/'));
  assert.equal(await testPathExists(arg, root), true);
  assert.equal(await testPathExists(sanitizeTestPathArgument('tests/test_b.py::test_x', root), root), false);
  assert.throws(() => sanitizeTestPathArgument('../test_a.py::test_x', root), /outside/);
});

/* ---------------- results ---------------- */

const LONGREPR_ASSERT = `page = <Page url='about:blank'>

    def test_total(page: Page):
        page.set_content(HTML)
>       expect(page.locator("#total")).to_have_text("$12.00", timeout=1000)
E       AssertionError: Locator expected to have text '$12.00'
E       Actual value: $10.00

tests/test_shop.py:14: AssertionError`;

const LONGREPR_TIMEOUT = `self = <test_shop.TestCheckout object at 0x7f>
page = <Page url='about:blank'>

    def test_button(self, page: Page):
        page.set_content(HTML)
>       page.get_by_test_id("checkout-button").click(timeout=1000)

tests/test_shop.py:20:
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
../venv/lib/python3.13/site-packages/playwright/sync_api/_generated.py:11021: in click
    self._sync(
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _

    async def wrap_api_call(self, cb):
>       raise rewrite_error(error, f"{parsed_st['apiName']}: {error}") from None
E       playwright._impl._errors.TimeoutError: Locator.click: Timeout 1000ms exceeded.
E       Call log:
E         - waiting for get_by_test_id("checkout-button")

../venv/lib/python3.13/site-packages/playwright/_impl/_connection.py:636: TimeoutError`;

const RESULTS = [
  { event: 'collected', count: 5, rootdir: '/proj' },
  { outcome: 'passed', duration: 0.75, path: '/proj/tests/test_shop.py', traces: [], nodeid: 'tests/test_shop.py::test_cart_loads[chromium]', file: 'tests/test_shop.py', line: 6 },
  { outcome: 'failed', duration: 1.12, when: 'call', longrepr: LONGREPR_ASSERT, crash: { path: '/proj/tests/test_shop.py', line: 14, message: "AssertionError: Locator expected to have text '$12.00'\nActual value: $10.00" }, path: '/proj/tests/test_shop.py', traces: ['/proj/test-results/tests-test-shop-py-test-total-chromium/trace.zip'], nodeid: 'tests/test_shop.py::test_total[chromium]', file: 'tests/test_shop.py', line: 11 },
  { outcome: 'failed', duration: 1.18, when: 'call', longrepr: LONGREPR_TIMEOUT, crash: { path: '/venv/lib/python3.13/site-packages/playwright/_impl/_connection.py', line: 636, message: 'playwright._impl._errors.TimeoutError: Locator.click: Timeout 1000ms exceeded.' }, path: '/proj/tests/test_shop.py', traces: [], nodeid: 'tests/test_shop.py::TestCheckout::test_button[chromium]', file: 'tests/test_shop.py', line: 17 },
  { outcome: 'error', duration: 0.01, when: 'setup', longrepr: "E       fixture 'db' not found", path: '/proj/tests/test_db.py', traces: [], nodeid: 'tests/test_db.py::test_rows', file: 'tests/test_db.py', line: 0 },
  { outcome: 'skipped', duration: 0, reason: 'Skipped: later', path: '/proj/tests/test_db.py', nodeid: 'tests/test_db.py::test_later', file: 'tests/test_db.py', line: 4 },
  { event: 'finished', exitstatus: 1 },
];

test('plugin results become failures with location, code frame, expected/actual and trace', () => {
  const parsed = parsePytestResults(RESULTS.map((r) => JSON.stringify(r)).join('\n'), '/proj');
  assert.deepEqual({ ...parsed.stats, duration: 0 }, { expected: 1, unexpected: 3, flaky: 0, skipped: 1, duration: 0 });
  assert.equal(parsed.collected, 5);
  assert.equal(parsed.exitStatus, 1);
  const [total, button, setup] = parsed.failures;
  assert.equal(total.file, 'tests/test_shop.py');
  assert.equal(total.line, 14);
  assert.equal(total.title, 'test_shop.py › test_total');
  assert.equal(total.project, 'chromium');
  assert.equal(total.failureKind, 'assertion');
  assert.equal(total.expected, '$12.00');
  assert.equal(total.actual, '$10.00');
  assert.equal(total.tracePath, '/proj/test-results/tests-test-shop-py-test-total-chromium/trace.zip');
  assert.match(total.codeframe, /^>\s+expect\(page\.locator\("#total"\)\)/m);
  // The crash is inside Playwright; the line comes from the test file's own frame.
  assert.equal(button.line, 20);
  assert.equal(button.status, 'failed');
  assert.equal(button.failureKind, 'timeout');
  assert.match(button.stack, /frames? inside libraries/);
  assert.doesNotMatch(button.stack, /_generated\.py/);
  assert.equal(setup.message, "fixture 'db' not found");
  assert.equal(setup.line, 1);
  assert.equal(parsed.outcomes.length, 5);
});

test('a run cut off mid-way keeps the tests that finished and drops a torn last line', () => {
  const raw = RESULTS.slice(0, 3).map((r) => JSON.stringify(r)).join('\n') + '\n{"outcome": "fail';
  const parsed = parsePytestResults(raw, '/proj');
  assert.equal(parsed.exitStatus, undefined);
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.stats.expected, 1);
});

test('traceback helpers', () => {
  assert.equal(testFileLine(LONGREPR_TIMEOUT, 'tests/test_shop.py'), 20);
  assert.equal(testFileLine('no frames here', 'tests/test_shop.py'), undefined);
  assert.equal(pytestCodeFrame('E   only an error'), undefined);
  assert.equal(shortTraceback('short'), 'short');
  assert.deepEqual(expectedActual('assert 3 == 4'), { expected: '4', actual: '3' });
  assert.deepEqual(expectedActual("Locator expected to be visible\nActual value: None"), { actual: 'None' });
});

test('run-level problems name the missing piece', () => {
  assert.equal(diagnosePytestOutput('/usr/bin/python3: No module named pytest', 1).errorKind, 'NO_PLAYWRIGHT');
  assert.match(diagnosePytestOutput('pytest: error: unrecognized arguments: --tracing retain-on-failure', 4).hint, /pip install pytest-playwright/);
  assert.equal(diagnosePytestOutput('', 5).errorKind, 'INVALID_PATH');
  assert.equal(diagnosePytestOutput('E   SyntaxError: invalid syntax', 2).errorKind, 'SYNTAX_ERROR');
  assert.equal(diagnosePytestOutput('1 failed', 1), null);
});

test('only an allowlist of pytest flags passes through, and Node-only options are refused', async () => {
  const root = tmpRoot();
  writeFileSync(path.join(root, 'pytest.ini'), '[pytest]\n');
  await assert.rejects(runPytest({ projectRoot: root, extraArgs: ['--rootdir=/etc'] }), /not allowed/);
  await assert.rejects(runPytest({ projectRoot: root, extraArgs: ['-p', 'evil'] }), /not allowed/);
  await assert.rejects(runPytest({ projectRoot: root, repeatEach: 3 }), /not supported for pytest/);
  await assert.rejects(runPytest({ projectRoot: root, testFiles: [`${root}/-x.py`] }), /starting with "-"/);
  await assert.rejects(runPytest({ projectRoot: root, browser: 'chrome' }), /not a pytest-playwright browser/);
});

/* ---------------- live (needs PW_MCP_PYTHON with pytest-playwright) ---------------- */

function livePython() {
  const python = process.env.PW_MCP_PYTHON;
  if (!python) return null;
  try {
    execFileSync(python, ['-c', 'import pytest_playwright'], { stdio: 'ignore' });
    return python;
  } catch {
    return null;
  }
}

const LIVE_SPEC = `from playwright.sync_api import Page, expect

HTML = "<h1>Cart</h1><button data-testid='checkout-btn'>Proceed to checkout</button><p id='total'>$10.00</p>"


def test_cart_loads(page: Page):
    page.set_content(HTML)
    expect(page.get_by_role("heading", name="Cart")).to_be_visible()


def test_total(page: Page):
    page.set_content(HTML)
    expect(page.locator("#total")).to_have_text("$12.00", timeout=1000)


class TestCheckout:
    def test_button(self, page: Page):
        page.set_content(HTML)
        page.get_by_test_id("checkout-button").click(timeout=1000)
`;

test('live: run-test, get-failure and list-tests on a pytest-playwright project', { skip: livePython() ? false : 'set PW_MCP_PYTHON to a Python with pytest-playwright' }, async () => {
  const root = tmpRoot();
  writeFileSync(path.join(root, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests', 'test_shop.py'), LIVE_SPEC);
  const ctx = ctxFor(root);

  const listed = textOf(await listTestsTool.handler({}, ctx));
  assert.match(listed, /pytest `--collect-only`/);
  assert.match(listed, /TestCheckout › test_button/);

  const run = await runTestTool.handler({}, ctx);
  assert.equal(run.structuredContent.run.passed, 1);
  assert.equal(run.structuredContent.run.failed, 2);
  assert.match(textOf(run), /\*\*Expected:\*\* `\$12\.00`/);

  const failure = textOf(await getFailureTool.handler({ index: 2 }, ctx));
  assert.match(failure, /tests\/test_shop\.py:19/);
  assert.match(failure, /DOM at failure \(Playwright trace\)/);
  assert.match(failure, /checkout-btn/);

  const single = await runTestTool.handler({ testFiles: ['tests/test_shop.py:19'] }, ctx);
  assert.match(textOf(single), /tests\/test_shop\.py::TestCheckout::test_button/);
  assert.equal(single.structuredContent.run.failed, 1);

  // Index 2 after the single run above is gone; re-run the suite for both failures.
  await runTestTool.handler({}, ctx);
  const drift = textOf(await suggestFixTool.handler({ index: 2 }, ctx));
  assert.match(drift, /Proposed locator fix/);
  assert.match(drift, /\+\s+page\.get_by_(?:role\("button", name="Proceed to checkout"\)|test_id\("checkout-btn"\))\.click\(timeout=1000\)/);
  const applied = await suggestFixTool.handler({ index: 2, apply: true }, ctx);
  assert.match(textOf(applied), /Verified — the test passes/);
  assert.doesNotMatch(readFileSync(path.join(root, 'tests', 'test_shop.py'), 'utf8'), /checkout-button/);
  assert.match(textOf(await diagnoseFlakyTool.handler({}, ctx)), /does not support pytest projects yet/);
});
