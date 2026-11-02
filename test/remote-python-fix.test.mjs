import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnect } from '../dist/tools/shared.js';
import { resolveEnvTokens, secretEnvAllowed } from '../dist/utils/env-tokens.js';
import { findPythonChainSpan, formatPythonLocator, pythonMessageToTs, readPythonChain } from '../dist/utils/python-locator.js';
import { parseLocator } from '../dist/utils/locator-expr.js';

test('connect: ws endpoints, cdp URLs, env tokens and refusals', () => {
  process.env.E2E_GRID_KEY = 's3cret';
  try {
    assert.deepEqual(resolveConnect('ws://localhost:3000/', {}), { url: 'ws://localhost:3000/', cdp: false, host: 'localhost:3000' });
    const cdp = resolveConnect('cdp:http://127.0.0.1:9222', {});
    assert.equal(cdp.cdp, true);
    assert.equal(cdp.url, 'http://127.0.0.1:9222');
    assert.equal(resolveConnect('wss://grid.example.com/pw?key={{env:E2E_GRID_KEY}}', {}).url, 'wss://grid.example.com/pw?key=s3cret');
    assert.equal(resolveConnect(undefined, {}), undefined);
    assert.throws(() => resolveConnect('http://localhost:3000', {}), /ws:\/\/ or wss:\/\//);
    assert.throws(() => resolveConnect('not a url', {}), /not a valid URL/);
    assert.throws(() => resolveConnect('ws://localhost:3000', { restricted: true }), /not available/);
    assert.throws(() => resolveConnect('wss://x/?k={{env:AWS_SECRET_ACCESS_KEY}}', {}), /not an allowed variable/);
  } finally {
    delete process.env.E2E_GRID_KEY;
  }
});

test('env tokens never expose the server\'s own PW_MCP_* settings', () => {
  assert.equal(secretEnvAllowed('E2E_API_TOKEN'), true);
  assert.equal(secretEnvAllowed('PW_MCP_HTTP_TOKEN'), false);
  assert.equal(secretEnvAllowed('PW_MCP_HISTORY_TOKEN'), false);
  assert.throws(() => resolveEnvTokens('{{env:E2E_UNSET_FOR_TEST}}'), /Not set/);
});

test('Python locators convert to TypeScript and back', () => {
  const src = 'page.get_by_role("button", name="Buy now", exact=True).first.click(timeout=1000)';
  const read = readPythonChain(src, src.indexOf('get_by_role'));
  assert.equal(read.ts, "getByRole('button', { name: 'Buy now', exact: true }).first()");
  assert.equal(src.slice(read.end), '.click(timeout=1000)');
  assert.equal(formatPythonLocator(parseLocator(read.ts)), 'get_by_role("button", name="Buy now", exact=True).first');
  assert.equal(readPythonChain('get_by_text(re.compile(r"total", re.IGNORECASE))', 0).ts, 'getByText(/total/i)');
  assert.equal(formatPythonLocator(parseLocator("getByTestId('checkout').locator('span')")), 'get_by_test_id("checkout").locator("span")');
  assert.match(pythonMessageToTs('waiting for get_by_test_id("checkout-button")'), /getByTestId\('checkout-button'\)/);
  assert.equal(readPythonChain(String.raw`get_by_text("It's \"ok\" \\ done")`, 0).ts, String.raw`getByText('It\'s "ok" \\ done')`);
  assert.equal(readPythonChain(String.raw`get_by_text(re.compile(r"a/b\/c\d"))`, 0).ts, String.raw`getByText(/a\/b\/c\d/)`);
  assert.equal(readPythonChain(String.raw`locator(r"\d+")`, 0).ts, String.raw`locator('\\d+')`);
  const line = '    page.get_by_test_id("checkout-button").click()';
  const span = findPythonChainSpan(line, parseLocator("getByTestId('checkout-button')"));
  assert.equal(line.slice(span.start, span.end), 'get_by_test_id("checkout-button")');
});
