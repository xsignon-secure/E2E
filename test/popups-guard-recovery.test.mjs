/**
 * Popups and new tabs (switchTab), write blocking for page tools, the heal
 * guard's try/catch and missing-await rules, and failures recovered from
 * the live reporter when Playwright never writes its JSON report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createToolStore, describeBlockedWrites, describePageState, describeTabs, resolvePageState } from '../dist/tools/shared.js';
import { PROBE_SCRIPT } from '../dist/tools/probe-script.js';
import { guardFileChange, guardVerdict, tryShapes, unawaitedAssertions, maskCode } from '../dist/utils/test-change-guard.js';
import { liveResultsToReport } from '../dist/utils/live-reporter.js';
import { parseReport } from '../dist/utils/report-parser.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const ctxFor = (root) => ({ logger: silent, store: createToolStore(), projectRoot: root });
const tmpRoot = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-popups-')));

/* ---------------- switchTab ---------------- */

test('switchTab steps resolve with a default of the newest tab', async () => {
  const root = tmpRoot();
  const state = await resolvePageState(
    { actions: [{ type: 'click', locator: "getByRole('button', { name: 'SSO' })" }, { type: 'switchTab' }, { type: 'switchTab', value: ' accounts.example ' }] },
    root,
    'http://example.test/',
    ctxFor(root),
  );
  assert.deepEqual(state.actions.slice(1), [
    { type: 'switchTab', label: 'switchTab last', value: 'last' },
    { type: 'switchTab', label: 'switchTab accounts.example', value: 'accounts.example' },
  ]);
  await assert.rejects(
    resolvePageState({ actions: [{ type: 'switchTab', value: 'x'.repeat(201) }] }, root, 'http://example.test/', ctxFor(root)),
    /too long/,
  );
});

test('the open tabs are listed only when there is more than one', () => {
  assert.deepEqual(describeTabs(undefined), []);
  assert.deepEqual(describeTabs([{ url: 'http://a.test/', title: 'A', active: true }]), []);
  const lines = describeTabs([
    { url: 'http://a.test/', title: 'Shop', active: false },
    { url: 'http://sso.test/login', title: 'Sign  in', active: true },
  ]);
  assert.match(lines[0], /Open tabs \(2\)/);
  assert.equal(lines[1], '1. http://a.test/ "Shop"');
  assert.equal(lines[2], '2. **(inspected)** http://sso.test/login "Sign in"');
});

test('the browser script still compiles with the tab helpers', () => {
  assert.doesNotThrow(() => new vm.Script(PROBE_SCRIPT, { filename: 'probe.cjs' }));
  assert.match(PROBE_SCRIPT, /async function findTab\(context, want, timeout\)/);
  assert.match(PROBE_SCRIPT, /\/\^\\d\+\$\/\.test\(target\)/);
});

/* ---------------- blockWrites ---------------- */

test('blockWrites comes from the argument or PW_MCP_BLOCK_WRITES', async () => {
  const root = tmpRoot();
  const url = 'http://example.test/';
  const saved = process.env.PW_MCP_BLOCK_WRITES;
  try {
    delete process.env.PW_MCP_BLOCK_WRITES;
    assert.equal((await resolvePageState({}, root, url, ctxFor(root))).blockWrites, undefined);
    assert.equal((await resolvePageState({ blockWrites: true }, root, url, ctxFor(root))).blockWrites, true);
    process.env.PW_MCP_BLOCK_WRITES = '1';
    assert.equal((await resolvePageState({}, root, url, ctxFor(root))).blockWrites, true);
    assert.equal((await resolvePageState({ blockWrites: false }, root, url, ctxFor(root))).blockWrites, undefined);
  } finally {
    if (saved === undefined) delete process.env.PW_MCP_BLOCK_WRITES;
    else process.env.PW_MCP_BLOCK_WRITES = saved;
  }
  assert.equal(describePageState({ blockWrites: true }, root), 'write requests blocked');
});

test('blocked writes are listed with a count of the rest', () => {
  assert.deepEqual(describeBlockedWrites(undefined), []);
  const requests = Array.from({ length: 20 }, (_, i) => ({ method: 'POST', url: `http://a.test/api/${i}` }));
  const lines = describeBlockedWrites({ total: 23, requests });
  assert.match(lines[0], /Write requests blocked \(23\)/);
  assert.equal(lines[1], '- `POST http://a.test/api/0`');
  assert.equal(lines.at(-1), '- … and 3 more');
});

/* ---------------- heal guard: try/catch and await ---------------- */

const BASE = `import { test, expect } from '@playwright/test';

test('user checks out', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('submit')).toBeVisible();
  await page.getByTestId('submit').click();
  expect(page.url()).toContain('/success');
});
`;

const swap = (from, to) => {
  assert.ok(BASE.includes(from), `fixture lacks ${from}`);
  return BASE.replace(from, to);
};
const rules = (after) => guardFileChange('tests/checkout.spec.ts', BASE, after).findings.map((f) => `${f.severity}:${f.rule}`);

test('an assertion wrapped in a swallowing try/catch is blocked', () => {
  const empty = swap("  await expect(page.getByTestId('submit')).toBeVisible();\n", "  try {\n    await expect(page.getByTestId('submit')).toBeVisible();\n  } catch (e) {}\n");
  assert.deepEqual(rules(empty), ['block:assertion-swallowed']);
  const logged = swap(
    "  await expect(page.getByTestId('submit')).toBeVisible();\n",
    "  try {\n    await expect(page.getByTestId('submit')).toBeVisible();\n  } catch (err) {\n    console.warn('ignoring', err);\n  }\n",
  );
  assert.deepEqual(rules(logged), ['block:assertion-swallowed']);
  assert.equal(guardVerdict([guardFileChange('a.spec.ts', BASE, logged)]), 'BLOCK');
});

test('a try/catch that rethrows or asserts, or a try/finally, is fine', () => {
  const rethrow = swap(
    "  await expect(page.getByTestId('submit')).toBeVisible();\n",
    "  try {\n    await expect(page.getByTestId('submit')).toBeVisible();\n  } catch (err) {\n    console.error('step 2');\n    throw err;\n  }\n",
  );
  assert.deepEqual(rules(rethrow), []);
  const fallback = swap(
    "  await expect(page.getByTestId('submit')).toBeVisible();\n",
    "  try {\n    await expect(page.getByTestId('submit')).toBeVisible();\n  } catch {\n    await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible();\n  }\n",
  );
  assert.deepEqual(rules(fallback), []);
  const cleanup = swap("  await page.getByTestId('submit').click();\n", "  try {\n    await page.getByTestId('submit').click();\n  } finally {\n    await page.close();\n  }\n");
  assert.deepEqual(rules(cleanup), []);
});

test('a try/catch around a step (not an assertion) that swallows still warns', () => {
  const step = swap("  await page.getByTestId('submit').click();\n", "  try {\n    await page.getByTestId('submit').click();\n  } catch {}\n");
  assert.deepEqual(rules(step), ['warn:error-swallowed']);
});

test('a web-first assertion that lost its await warns; sync expects are left alone', () => {
  const unawaited = swap("  await expect(page.getByTestId('submit')).toBeVisible();", "  expect(page.getByTestId('submit')).toBeVisible();");
  assert.deepEqual(rules(unawaited), ['warn:assertion-not-awaited']);
  const negated = swap("  await expect(page.getByTestId('submit')).toBeVisible();", "  expect(page.getByTestId('submit')).not.toBeHidden();");
  assert.ok(rules(negated).includes('warn:assertion-not-awaited'));
  // expect(page.url()).toContain(...) in BASE is synchronous and was never flagged.
  assert.equal(unawaitedAssertions(maskCode(BASE)), 0);
});

test('expects collected for Promise.all, returned or polled are judged correctly', () => {
  const masked = (code) => maskCode(code);
  assert.equal(unawaitedAssertions(masked('await Promise.all([expect(a).toBeVisible(), expect(b).toHaveText("x")]);')), 0);
  assert.equal(unawaitedAssertions(masked('const done = expect(a).toBeVisible();\nawait done;')), 0);
  assert.equal(unawaitedAssertions(masked('return expect(a).toBeVisible();')), 0);
  assert.equal(unawaitedAssertions(masked('{\n  expect.poll(() => n).toBe(3);\n}')), 1);
  assert.equal(unawaitedAssertions(masked('{\n  expect.soft(a).toHaveText("x");\n}')), 1);
  assert.equal(unawaitedAssertions(masked('{\n  expect(n).toBe(3);\n  expect(list).toHaveLength(2);\n}')), 0);
  // Words inside strings and comments never count.
  assert.equal(unawaitedAssertions(masked('{\n  // expect(a).toBeVisible();\n  const s = "expect(a).toBeVisible()";\n}')), 0);
});

test('tryShapes separates swallowing tries from safe ones', () => {
  const shape = tryShapes(maskCode('try { await expect(a).toBeVisible(); } catch (e) { log(e); }\ntry { x(); } catch (e) { throw e; }\ntry { y(); } catch {}\ntry { z(); } finally { w(); }'));
  assert.deepEqual(shape, { unsafe: 2, swallowedAssertions: 1 });
});

/* ---------------- live reporter recovery ---------------- */

const line = (fields) => JSON.stringify({ titlePath: ['checkout.spec.ts', 'pays'], file: '/proj/tests/checkout.spec.ts', line: 3, project: 'chromium', retry: 0, errors: [], attachments: [], ...fields });

test('live results turn back into failures with message, code frame and trace', () => {
  const raw = [
    line({ titlePath: ['checkout.spec.ts', 'loads'], line: 1, status: 'passed', duration: 120 }),
    line({
      status: 'failed',
      duration: 900,
      errors: [{ message: 'Error: expect(locator).toBeVisible() failed', stack: 'at /proj/tests/checkout.spec.ts:5:3', codeframe: '> 5 | await expect(x).toBeVisible();', location: { file: '/proj/tests/checkout.spec.ts', line: 5, column: 3 } }],
      attachments: [{ name: 'trace', path: '/proj/test-results/pays/trace.zip', contentType: 'application/zip' }],
    }),
    line({ status: 'failed', retry: 1, duration: 800, errors: [{ message: 'Error: retry failed too' }] }),
    line({ titlePath: ['checkout.spec.ts', 'cut short'], line: 9, status: 'interrupted', errors: [{ message: 'Test was interrupted.' }] }),
    '{"titlePath": ["half a line wr',
  ].join('\n');
  const report = liveResultsToReport(raw);
  const parsed = parseReport(report, '/proj');
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.stats.expected, 1);
  assert.equal(parsed.stats.unexpected, 2);
  const [pays, cut] = parsed.failures;
  assert.equal(pays.file, 'tests/checkout.spec.ts');
  assert.equal(pays.title, 'checkout.spec.ts › pays');
  assert.equal(pays.retry, 1);
  assert.equal(pays.message, 'Error: retry failed too');
  assert.equal(cut.title, 'checkout.spec.ts › cut short');
  assert.equal(cut.status, 'failed');
});

test('the first attempt keeps its trace and code frame when it is the last one', () => {
  const report = liveResultsToReport(
    line({
      status: 'timedOut',
      errors: [{ message: 'Test timeout of 30000ms exceeded.', codeframe: '> 5 | await page.click("#pay");' }],
      attachments: [{ name: 'trace', path: '/proj/test-results/pays/trace.zip', contentType: 'application/zip' }],
    }),
  );
  const [failure] = parseReport(report, '/proj').failures;
  assert.equal(failure.status, 'timedOut');
  assert.equal(failure.failureKind, 'timeout');
  assert.match(failure.codeframe, /page\.click/);
  assert.equal(failure.tracePath, '/proj/test-results/pays/trace.zip');
});

test('no finished test means no recovered report', () => {
  assert.equal(liveResultsToReport(''), undefined);
  assert.equal(liveResultsToReport('not json\n{"status": "failed"}\n'), undefined);
});
