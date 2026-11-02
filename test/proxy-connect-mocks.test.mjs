/**
 * 0.14.1: the sign-in limiter's client address behind a reverse proxy, the
 * hosts an agent-chosen `connect` URL may send {{env:…}} secrets to, and
 * check-mocks reading JSON bodies written as string literals.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedClientAddress } from '../dist/http.js';
import { resolveConnect, trustedConnectHosts } from '../dist/tools/shared.js';
import { findMocks, jsonFromStringLiteral } from '../dist/utils/mock-drift.js';

const headers = (values) => new Headers(values);

test('without PW_MCP_TRUST_PROXY, client headers are ignored', () => {
  const h = headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' });
  assert.equal(trustedClientAddress(h, '10.0.0.5', undefined), '10.0.0.5');
  assert.equal(trustedClientAddress(h, '10.0.0.5', '0'), '10.0.0.5');
  assert.equal(trustedClientAddress(h, '10.0.0.5', 'yes'), '10.0.0.5');
});

test('PW_MCP_TRUST_PROXY=1 takes the entry the proxy appended, not the forged leftmost one', () => {
  // The client sent "X-Forwarded-For: 1.2.3.4"; the proxy appended the real address.
  const h = headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9', 'x-real-ip': '9.9.9.9' });
  assert.equal(trustedClientAddress(h, '10.0.0.5', '1'), '198.51.100.9');
  // A forged X-Real-IP is not read in this mode.
  assert.equal(trustedClientAddress(headers({ 'x-real-ip': '9.9.9.9' }), '10.0.0.5', '1'), '10.0.0.5');
});

test('PW_MCP_TRUST_PROXY=2 counts two proxies from the right', () => {
  const h = headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9, 10.1.1.1' });
  assert.equal(trustedClientAddress(h, '10.0.0.5', '2'), '198.51.100.9');
  // Fewer entries than proxies: something is off, use the socket.
  assert.equal(trustedClientAddress(headers({ 'x-forwarded-for': '198.51.100.9' }), '10.0.0.5', '2'), '10.0.0.5');
});

test('PW_MCP_TRUST_PROXY=x-real-ip reads X-Real-IP only', () => {
  const h = headers({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '198.51.100.9' });
  assert.equal(trustedClientAddress(h, '10.0.0.5', 'x-real-ip'), '198.51.100.9');
  assert.equal(trustedClientAddress(headers({}), '10.0.0.5', 'X-Real-IP'), '10.0.0.5');
});

async function withEnv(values, fn) {
  const names = ['PW_MCP_CONNECT', 'PW_MCP_CONNECT_HOSTS', 'E2E_GRID_KEY', 'PW_MCP_BLOCK_PRIVATE_URLS'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

const ctx = { restricted: false };

test('connect: an agent-chosen URL cannot carry {{env:…}} secrets to an unknown host', async () => {
  await withEnv({ E2E_GRID_KEY: 'secret-key' }, () => {
    assert.throws(() => resolveConnect('wss://evil.example/pw?key={{env:E2E_GRID_KEY}}', ctx), (error) => {
      assert.equal(error.kind, 'INVALID_INPUT');
      assert.match(error.message, /evil\.example/);
      assert.match(error.hint, /PW_MCP_CONNECT_HOSTS/);
      return true;
    });
    // No secret in it: any endpoint is fine, as before.
    assert.equal(resolveConnect('wss://grid.example.com/pw', ctx).host, 'grid.example.com');
    // This machine is fine.
    assert.match(resolveConnect('ws://localhost:3000/?k={{env:E2E_GRID_KEY}}', ctx).url, /secret-key/);
  });
});

test('connect: hosts named in PW_MCP_CONNECT or PW_MCP_CONNECT_HOSTS may receive secrets', async () => {
  await withEnv({ E2E_GRID_KEY: 'secret-key', PW_MCP_CONNECT_HOSTS: 'grid.example.com, wss://cloud.example.org:9443/' }, () => {
    assert.deepEqual([...trustedConnectHosts()].sort(), ['cloud.example.org:9443', 'grid.example.com']);
    assert.match(resolveConnect('wss://grid.example.com/pw?key={{env:E2E_GRID_KEY}}', ctx).url, /key=secret-key/);
    assert.match(resolveConnect('wss://cloud.example.org:9443/?key={{env:E2E_GRID_KEY}}', ctx).url, /secret-key/);
    assert.throws(() => resolveConnect('wss://cloud.example.org/?key={{env:E2E_GRID_KEY}}', ctx), /cloud\.example\.org/);
  });
  await withEnv({ E2E_GRID_KEY: 'secret-key', PW_MCP_CONNECT: 'wss://hub.example.net/pw?key={{env:E2E_GRID_KEY}}' }, () => {
    // The user's own default is trusted, and so is its host for an agent-chosen URL.
    assert.match(resolveConnect(undefined, ctx).url, /secret-key/);
    assert.match(resolveConnect('wss://hub.example.net/other?key={{env:E2E_GRID_KEY}}', ctx).url, /secret-key/);
    assert.throws(() => resolveConnect('cdp:http://evil.example:9222/?k={{env:E2E_GRID_KEY}}', ctx), /evil\.example/);
  });
});

test('check-mocks reads a JSON body written as a string literal (Python and TS)', () => {
  assert.deepEqual(jsonFromStringLiteral(`'{"id": 1, "name": "Ann"}'`, 0), { id: 1, name: 'Ann' });
  assert.deepEqual(jsonFromStringLiteral(`r'{"path": "a\\\\b"}'`, 0), { path: 'a\\b' });
  assert.deepEqual(jsonFromStringLiteral(`"""\n{"items": [{"price": 2}]}\n"""`, 0), { items: [{ price: 2 }] });
  assert.deepEqual(jsonFromStringLiteral('`{"ok": true}`', 0), { ok: true });
  assert.equal(jsonFromStringLiteral('`{"id": ${id}}`', 0), undefined);
  assert.equal(jsonFromStringLiteral(`'not json'`, 0), undefined);

  const py = [
    'def test_cart(page):',
    '    page.route("**/api/cart", lambda route: route.fulfill(status=200, content_type="application/json", body=\'{"items": [], "total": 0}\'))',
    '    page.goto("/")',
  ].join('\n');
  const [mock] = findMocks('tests/test_cart.py', py);
  assert.ok(mock, 'the Python mock is found');
  assert.deepEqual(mock.body, { items: [], total: 0 });

  const ts = "await page.route('**/api/user', (route) => route.fulfill({ status: 200, body: '{\"name\": \"Ann\"}' }));";
  const [tsMock] = findMocks('tests/user.spec.ts', ts);
  assert.deepEqual(tsMock.body, { name: 'Ann' });
});
