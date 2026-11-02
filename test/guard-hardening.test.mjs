import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalAssertions, earlyReturns, guardFileChange, isGuardedFile, maskCode, maskPython, pythonShapeOf } from '../dist/utils/test-change-guard.js';
import { baseCopyName, compareAssertionRuns } from '../dist/tools/check-test-change.js';
import { parseAttempts } from '../dist/utils/attempts-reporter.js';

const spec = (body) => `import { test, expect } from '@playwright/test';\ntest('total', async ({ page }) => {\n${body}\n});\n`;
const rules = (result) => result.findings.map((f) => `${f.severity}:${f.rule}`);

test('an assertion moved under an if is blocked', () => {
  const before = spec("  await expect(page.locator('#total')).toHaveText('€12');");
  const after = spec("  if (await page.locator('#promo').isVisible()) {\n    await expect(page.locator('#total')).toHaveText('€12');\n  }");
  assert.deepEqual(rules(guardFileChange('a.spec.ts', before, after)), ['block:assertion-made-conditional']);
});

test('short-circuit and ternary assertions count as conditional', () => {
  assert.equal(conditionalAssertions(maskCode('ok && await expect(a).toBeVisible(); x ? expect(b).toBe(1) : null;')), 2);
  assert.equal(conditionalAssertions(maskCode('await expect(a).toBeVisible(); for (const r of rows) { await expect(r).toBeVisible(); }')), 0);
  assert.equal(conditionalAssertions(maskCode('if (a) { x(); } else { await expect(b).toBeVisible(); }')), 1);
});

test('a new conditional assertion next to the old ones only warns', () => {
  const before = spec("  await expect(page.locator('#total')).toHaveText('€12');");
  const after = spec("  await expect(page.locator('#total')).toHaveText('€12');\n  if (mobile) await expect(page.locator('#menu')).toBeVisible();");
  assert.deepEqual(rules(guardFileChange('a.spec.ts', before, after)), ['warn:assertion-made-conditional']);
});

test('an early return before assertions warns', () => {
  const before = spec("  await page.goto('/');\n  await expect(page.locator('h1')).toBeVisible();");
  const after = spec("  await page.goto('/');\n  if (process.env.CI) return;\n  await expect(page.locator('h1')).toBeVisible();");
  assert.ok(rules(guardFileChange('a.spec.ts', before, after)).includes('warn:early-return'));
  assert.equal(earlyReturns(maskCode('await expect(a).toBeVisible(); return;')), 0, 'a return after the last assertion is harmless');
});

test('Python: masking, test discovery and the same rules as TypeScript', () => {
  assert.equal(maskPython('x = "assert expect(" # assert\nassert y').includes('expect('), false);
  const before = [
    'import pytest',
    'from playwright.sync_api import Page, expect',
    '',
    'def test_total(page: Page):',
    '    page.goto("/cart")',
    '    expect(page.locator("#total")).to_have_text("€12")',
    '    assert page.title() == "Cart"',
    '',
    'class TestCheckout:',
    '    def test_pay(self, page):',
    '        expect(page.get_by_role("button", name="Pay")).to_be_visible()',
  ].join('\n');
  const shape = pythonShapeOf(before);
  assert.deepEqual([...shape.tests.keys()], ['test_total', 'TestCheckout › test_pay']);
  assert.equal(shape.tests.get('test_total').assertions, 2);
  assert.equal(shape.tests.get('test_total').strong, 1);

  const weakened = before
    .replace('    expect(page.locator("#total")).to_have_text("€12")', '    try:\n        expect(page.locator("#total")).to_have_text("€12")\n    except AssertionError:\n        pass')
    .replace('    def test_pay(self, page):', '    @pytest.mark.skip(reason="flaky")\n    def test_pay(self, page):');
  const found = rules(guardFileChange('tests/test_cart.py', before, weakened));
  assert.ok(found.includes('block:assertion-swallowed'), found.join());
  assert.ok(found.includes('block:skip-added'), found.join());

  const conditional = before.replace('    expect(page.locator("#total")).to_have_text("€12")', '    if page.locator("#promo").is_visible():\n        expect(page.locator("#total")).to_have_text("€12")');
  assert.ok(rules(guardFileChange('tests/test_cart.py', before, conditional)).includes('block:assertion-made-conditional'));

  const looser = before.replace('to_have_text("€12")', 'to_be_attached()');
  assert.ok(rules(guardFileChange('tests/test_cart.py', before, looser)).includes('warn:weaker-matcher'));

  const removed = before.replace('    assert page.title() == "Cart"\n', '');
  assert.ok(rules(guardFileChange('tests/test_cart.py', before, removed)).includes('block:assertions-removed'));

  const xfail = before.replace('def test_total', '@pytest.mark.xfail\ndef test_total');
  assert.ok(rules(guardFileChange('tests/test_cart.py', before, xfail)).includes('block:skip-added'));

  const sleepy = before.replace('    page.goto("/cart")', '    page.goto("/cart")\n    page.wait_for_timeout(3000)');
  assert.ok(rules(guardFileChange('tests/test_cart.py', before, sleepy)).includes('warn:hard-wait-added'));
});

test('isGuardedFile covers pytest files', () => {
  assert.equal(isGuardedFile('tests/test_cart.py'), true);
  assert.equal(isGuardedFile('tests/cart_test.py'), true);
  assert.equal(isGuardedFile('app/models.py'), false);
});

test('runtime check: copy names and per-test assertion counts', () => {
  assert.equal(baseCopyName('tests/cart.spec.ts'), 'tests/cart.pwmcp-base.spec.ts');
  assert.equal(baseCopyName('e2e/a.test.mjs'), 'e2e/a.pwmcp-base.test.mjs');
  assert.equal(baseCopyName('tests/helpers.ts'), undefined);
  const raw = [
    { file: '/p/tests/cart.spec.ts', line: 2, title: 'total', status: 'passed', durationMs: 1, assertions: 1 },
    { file: '/p/tests/cart.pwmcp-base.spec.ts', line: 2, title: 'total', status: 'failed', durationMs: 1, assertions: 2 },
    { file: '/p/tests/cart.spec.ts', line: 9, title: 'same', status: 'passed', durationMs: 1, assertions: 3 },
    { file: '/p/tests/cart.pwmcp-base.spec.ts', line: 9, title: 'same', status: 'passed', durationMs: 1, assertions: 3 },
  ].map((e) => JSON.stringify(e)).join('\n');
  const attempts = parseAttempts(raw, '/p');
  assert.equal(attempts[0].assertions, 1);
  const rows = compareAssertionRuns(attempts, [{ file: 'tests/cart.spec.ts', copy: 'tests/cart.pwmcp-base.spec.ts' }]);
  assert.deepEqual(rows.map((r) => [r.title, r.before, r.after]), [['total', 2, 1], ['same', 3, 3]]);
});
