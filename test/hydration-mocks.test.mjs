import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectHydrationRace, hydrationErrorMessages } from '../dist/utils/trace-reader.js';
import { renderHydration } from '../dist/tools/get-failure.js';
import { describeHydration, hydrationWait } from '../dist/tools/shared.js';
import { scanFlakeRisks, ssrFramework } from '../dist/utils/flake-rules.js';
import { diffShapes, findMocks, liveUrl, mocksFromHar, parseLiteral, shapeOf, UNKNOWN } from '../dist/utils/mock-drift.js';
import { checkProjectMocks, compareWithLive, renderMockReport, resolveHeaders } from '../dist/tools/check-mocks.js';

/* ------------------------------------------------------------------ */
/* Hydration                                                           */
/* ------------------------------------------------------------------ */

// Shaped like a real Playwright 1.64 trace: the click starts while the
// page's only script is still downloading, then the assertion fails.
const network = [
  { type: 'resource-snapshot', snapshot: { request: { url: 'http://app/' }, _resourceType: 'document', _monotonicTime: 2229.9, time: 15.2 } },
  { type: 'resource-snapshot', snapshot: { request: { url: 'http://app/_next/static/chunks/main.js' }, _resourceType: 'script', _monotonicTime: 2265.8, time: 1510.5 } },
].map((e) => JSON.stringify(e)).join('\n');
const events = (clickAt) => [
  { type: 'before', callId: 'c@52', class: 'Frame', method: 'goto', startTime: 2198.4, params: { url: 'http://app/' } },
  { type: 'after', callId: 'c@52', endTime: 2252.5 },
  { type: 'before', callId: 'c@54', class: 'Frame', method: 'click', startTime: clickAt, params: { selector: 'internal:role=button[name="Go"i]' } },
  { type: 'after', callId: 'c@54', endTime: clickAt + 180 },
  { type: 'before', callId: 'c@56', class: 'Frame', method: 'expect', startTime: clickAt + 200, params: {} },
  { type: 'after', callId: 'c@56', endTime: clickAt + 3200, error: { message: 'expect(locator).toHaveText(expected) failed' } },
].map((e) => JSON.stringify(e));

test('detectHydrationRace finds a click made while scripts were still loading', () => {
  const race = detectHydrationRace(events(2257.8), [network]);
  assert.equal(race.action, 'click');
  assert.equal(race.selector, 'internal:role=button[name="Go"i]');
  assert.equal(race.scriptCount, 1);
  assert.match(race.scripts[0], /main\.js/);
  assert.ok(race.pendingMs > 1400 && race.pendingMs < 1600, String(race.pendingMs));
});

test('detectHydrationRace stays quiet once the scripts had loaded', () => {
  assert.equal(detectHydrationRace(events(3900), [network]), undefined);
});

test('detectHydrationRace ignores a failure of the click itself', () => {
  const lines = events(2257.8).map((line) => {
    const e = JSON.parse(line);
    if (e.callId === 'c@54' && e.type === 'after') e.error = { message: 'Timeout 5000ms exceeded' };
    return JSON.stringify(e);
  });
  assert.equal(detectHydrationRace(lines, [network]), undefined);
});

test('hydrationErrorMessages picks hydration mismatches out of the console', () => {
  const lines = [
    JSON.stringify({ type: 'console', messageType: 'error', text: 'Error: Hydration failed because the server rendered HTML didn\'t match the client.' }),
    JSON.stringify({ type: 'console', messageType: 'error', text: 'Failed to load resource' }),
  ];
  const found = hydrationErrorMessages(lines);
  assert.equal(found.length, 1);
  assert.match(found[0], /Hydration failed/);
});

test('renderHydration explains the race and how to wait', () => {
  const text = renderHydration({ hydrationRace: { action: 'click', selector: '#buy', scripts: ['http://app/main.js'], scriptCount: 1, pendingMs: 900 } }).join('\n');
  assert.match(text, /Possible hydration race/);
  assert.match(text, /`click` on `#buy` ran while 1 script/);
  assert.match(text, /html\[data-hydrated\]/);
  assert.deepEqual(renderHydration({}), []);
});

test('describeHydration reports the gap only when there is one', () => {
  const gap = describeHydration({ framework: 'Next.js', ssr: true, state: 'hydrated', firstControlMs: 40, hydratedMs: 1240 }).join('\n');
  assert.match(gap, /⚡ Next\.js, server-rendered: controls were on screen \*\*1200 ms\*\*/);
  assert.match(gap, /useEffect/);
  assert.match(describeHydration({ framework: 'Next.js', ssr: true, state: 'hydrated', firstControlMs: 40, hydratedMs: 60 })[0], /no real gap/);
  assert.match(describeHydration({ framework: 'React', ssr: false, state: 'hydrated', firstControlMs: 300, hydratedMs: 300 })[0], /rendered in the browser/);
  assert.match(describeHydration({ framework: 'Nuxt', ssr: true, state: 'pending', firstControlMs: 30, hydratedMs: null }).join('\n'), /not hydrated.*\n.*onMounted/);
  assert.match(describeHydration({ framework: 'SvelteKit', ssr: true, state: 'unknown', firstControlMs: 30, hydratedMs: null })[0], /no public sign/);
  assert.deepEqual(describeHydration(undefined), []);
  assert.match(hydrationWait('Astro'), /astro-island\[ssr\]/);
  assert.match(hydrationWait('Qwik'), /resumes/);
});

test('audit-tests flags an action right after goto on a server-rendered app', () => {
  const spec = [
    "test('adds to cart', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.getByRole('button', { name: 'Add' }).click();",
    '});',
    "test('waits first', async ({ page }) => {",
    "  await page.goto('/');",
    "  await expect(page.locator('html[data-hydrated]')).toBeAttached();",
    "  await page.getByRole('button', { name: 'Add' }).click();",
    '});',
  ].join('\n');
  const ssr = scanFlakeRisks('a.spec.ts', spec, { ssr: 'Next.js' }).filter((f) => f.rule === 'act-before-hydration');
  assert.deepEqual(ssr.map((f) => [f.line, f.test]), [[3, 'adds to cart']]);
  assert.equal(scanFlakeRisks('a.spec.ts', spec).filter((f) => f.rule === 'act-before-hydration').length, 0, 'off for apps that are not server-rendered');
  assert.equal(ssrFramework({ dependencies: { next: '15.0.0', react: '19' } }), 'Next.js');
  assert.equal(ssrFramework({ devDependencies: { '@sveltejs/kit': '2' } }), 'SvelteKit');
  assert.equal(ssrFramework({ dependencies: { react: '19' } }), undefined);
});

/* ------------------------------------------------------------------ */
/* Mock drift                                                          */
/* ------------------------------------------------------------------ */

test('parseLiteral reads JS and Python literals and marks computed values unknown', () => {
  assert.deepEqual(parseLiteral("{ items: [{ id: 1, name: 'Mug', price: 9.5, tags: [] }], total: -3, ok: true, next: null, }"), {
    items: [{ id: 1, name: 'Mug', price: 9.5, tags: [] }],
    total: -3,
    ok: true,
    next: null,
  });
  assert.deepEqual(parseLiteral('{"user": {"id": 7, "admin": False, "email": None}}'), { user: { id: 7, admin: false, email: null } });
  const computed = parseLiteral('{ id: makeId(), when: `at ${now}`, n: count + 1, label: "a" + b }');
  assert.equal(computed.id, UNKNOWN);
  assert.equal(computed.when, 'at ');
  assert.equal(computed.n, UNKNOWN);
  assert.equal(computed.label, 'string');
  assert.equal(shapeOf(parseLiteral('{ ...base, id: 1 }')).partial, true);
});

test('diffShapes names missing fields, changed types and new nulls', () => {
  const mock = shapeOf({ items: [{ id: 1, price: 9.5, name: 'Mug' }], total: 9.5, coupon: 'X' });
  const live = shapeOf({ items: [{ id: 1, price: '9.50', title: 'Mug' }], total: 9.5, coupon: null, currency: 'EUR' });
  const findings = diffShapes(mock, live);
  const byRule = (rule) => findings.filter((f) => f.rule === rule).map((f) => f.path);
  assert.deepEqual(byRule('type-changed'), ['items[].price']);
  assert.deepEqual(byRule('missing-field'), ['items[].name']);
  assert.deepEqual(byRule('now-null'), ['coupon']);
  assert.deepEqual(byRule('new-field').length, 2, 'items[] gained title, the body gained currency');
  assert.match(findings.find((f) => f.rule === 'type-changed').message, /a \*\*number\*\* in the mock but a \*\*string\*\*/);
  assert.deepEqual(diffShapes(shapeOf({ a: 1 }), shapeOf({ a: 2 })), []);
  assert.deepEqual(diffShapes(shapeOf({ list: [] }), shapeOf({ list: [{ a: 1 }] })), [], 'an empty mock array says nothing about items');
});

test('findMocks reads route.fulfill in TS, named handlers, Python and HAR calls', () => {
  const ts = [
    "await page.route('**/api/cart', (route) => route.fulfill({ json: { items: [{ id: 1, price: 9.5 }] } }));",
    "await page.route(/\\/api\\/user\\/\\d+/, async (route) => { await route.fulfill({ status: 200, body: JSON.stringify({ id: 1 }) }); });",
    "await page.route('**/api/order', async (route) => { if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { ok: true } }); return route.fallback(); });",
    "await page.route('**/api/fail', (route) => route.fulfill({ status: 500, body: 'boom' }));",
    "await page.route('**/api/named', handleNamed);",
    "await page.route('**/api/pass', (route) => route.continue());",
    "await context.routeFromHAR('fixtures/api.har', { url: '**/api/**' });",
    'async function handleNamed(route) {',
    '  await route.fulfill({ json: { named: true } });',
    '}',
  ].join('\n');
  const mocks = findMocks('tests/shop.spec.ts', ts);
  assert.deepEqual(
    mocks.map((m) => [m.line, m.pattern, m.status, m.method ?? '', m.har ?? '']),
    [
      [1, '**/api/cart', 200, '', ''],
      [2, '/\\/api\\/user\\/\\d+/', 200, '', ''],
      [3, '**/api/order', 201, 'POST', ''],
      [4, '**/api/fail', 500, '', ''],
      [5, '**/api/named', 200, '', ''],
      [7, 'fixtures/api.har', 200, '', 'fixtures/api.har'],
    ],
  );
  assert.deepEqual(mocks[0].body, { items: [{ id: 1, price: 9.5 }] });
  assert.deepEqual(mocks[4].body, { named: true });
  assert.equal(mocks[1].regex, true);

  const py = [
    'def test_cart(page):',
    '    page.route("**/api/cart", lambda route: route.fulfill(json={"items": [], "total": 0}))',
    '    page.route("**/api/me", handle_me)',
    '',
    'def handle_me(route):',
    '    route.fulfill(status=200, body=json.dumps({"id": 1, "admin": True}))',
  ].join('\n');
  const pyMocks = findMocks('tests/test_cart.py', py);
  assert.deepEqual(pyMocks.map((m) => [m.line, m.pattern]), [[2, '**/api/cart'], [3, '**/api/me']]);
  assert.deepEqual(pyMocks[0].body, { items: [], total: 0 });
  assert.deepEqual(pyMocks[1].body, { id: 1, admin: true });
});

test('mocksFromHar keeps GET JSON entries once per URL', () => {
  const har = JSON.stringify({
    log: {
      entries: [
        { request: { method: 'GET', url: 'https://api.example.com/api/cart' }, response: { status: 200, content: { mimeType: 'application/json', text: '{"items":[]}' } } },
        { request: { method: 'GET', url: 'https://api.example.com/api/cart' }, response: { status: 200, content: { mimeType: 'application/json', text: '{"items":[1]}' } } },
        { request: { method: 'POST', url: 'https://api.example.com/api/order' }, response: { status: 201, content: { mimeType: 'application/json', text: '{}' } } },
        { request: { method: 'GET', url: 'https://api.example.com/logo.png' }, response: { status: 200, content: { mimeType: 'image/png', text: 'x' } } },
        { request: { method: 'GET', url: 'https://api.example.com/api/me' }, response: { status: 200, content: { mimeType: 'application/json', encoding: 'base64', text: Buffer.from('{"id":1}').toString('base64') } } },
      ],
    },
  });
  const found = mocksFromHar('a.spec.ts', 3, 'api.har', har);
  assert.deepEqual(found.map((m) => m.pattern), ['https://api.example.com/api/cart', 'https://api.example.com/api/me']);
  assert.deepEqual(found[1].body, { id: 1 });
});

test('liveUrl resolves globs against baseUrl and asks for a mapping otherwise', () => {
  assert.deepEqual(liveUrl({ pattern: '**/api/cart' }, 'http://localhost:3000'), { url: 'http://localhost:3000/api/cart' });
  assert.deepEqual(liveUrl({ pattern: '/api/cart?x=1' }, 'http://localhost:3000/'), { url: 'http://localhost:3000/api/cart?x=1' });
  assert.deepEqual(liveUrl({ pattern: 'https://api.example.com/v1/me' }, undefined), { url: 'https://api.example.com/v1/me' });
  assert.match(liveUrl({ pattern: '**/api/items/*' }, 'http://x').reason, /wildcard pattern/);
  assert.match(liveUrl({ pattern: '/\\/api\\/u/', regex: true }, 'http://x').reason, /regex pattern/);
  assert.deepEqual(liveUrl({ pattern: '**/api/items/*' }, 'http://x', { '**/api/items/*': '/api/items/1' }), { url: 'http://x/api/items/1' });
  assert.match(liveUrl({ pattern: '**/api/cart' }, undefined).reason, /no baseUrl/);
});

test('compareWithLive turns statuses into findings', () => {
  const mock = { file: 'a', line: 1, pattern: 'x', status: 200, body: { a: 1 } };
  assert.equal(compareWithLive(mock, { status: 404, contentType: '' })[0].rule, 'endpoint-gone');
  assert.equal(compareWithLive(mock, { status: 401, contentType: '' })[0].rule, 'status-changed');
  assert.equal(compareWithLive(mock, { status: 503, contentType: '' })[0].rule, 'server-error');
  assert.equal(compareWithLive(mock, { status: 200, contentType: 'text/html' })[0].rule, 'not-json');
  assert.equal(compareWithLive(mock, { status: 0, contentType: '', error: 'ECONNREFUSED' })[0].rule, 'server-error');
  assert.deepEqual(compareWithLive(mock, { status: 200, contentType: 'application/json', json: { a: 2 } }), []);
});

test('resolveHeaders reads allowed variables only', () => {
  process.env.E2E_API_TOKEN = 'tok123';
  assert.deepEqual(resolveHeaders({ Authorization: 'Bearer {{env:E2E_API_TOKEN}}' }), { Authorization: 'Bearer tok123' });
  assert.throws(() => resolveHeaders({ Authorization: '{{env:AWS_SECRET_ACCESS_KEY}}' }), /not an allowed variable/);
  delete process.env.E2E_API_TOKEN;
});

test('checkProjectMocks compares every mock in a project with a live server', async () => {
  const api = createServer((req, res) => {
    if (req.url === '/api/cart') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 1, price: '9.50' }], currency: 'EUR' }));
    } else if (req.url === '/api/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1, admin: true }));
    } else if (req.url === '/old') {
      res.writeHead(301, { location: '/api/me' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const root = mkdtempSync(path.join(tmpdir(), 'pwmcp-mocks-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(
      path.join(root, 'tests', 'shop.spec.ts'),
      [
        "await page.route('**/api/cart', (r) => r.fulfill({ json: { items: [{ id: 1, price: 9.5 }] } }));",
        "await page.route('**/api/me', (r) => r.fulfill({ json: { id: 1, admin: false } }));",
        "await page.route('**/api/gone', (r) => r.fulfill({ json: { a: 1 } }));",
        "await page.route('**/old', (r) => r.fulfill({ json: { id: 1 } }));",
        "await page.route('**/api/pay', (r) => { if (r.request().method() === 'POST') return r.fulfill({ json: { ok: true } }); });",
        "await page.route('**/api/items/*', (r) => r.fulfill({ json: { id: 1 } }));",
      ].join('\n'),
    );
    const { checks, filesScanned } = await checkProjectMocks(root.replace(/\\/g, '/'), { baseUrl: base });
    assert.equal(filesScanned, 1);
    const byPattern = Object.fromEntries(checks.map((c) => [c.mock.pattern, c]));
    assert.equal(byPattern['**/api/cart'].findings.find((f) => f.severity === 'high').rule, 'type-changed');
    assert.deepEqual(byPattern['**/api/me'].findings, []);
    assert.equal(byPattern['**/api/gone'].findings[0].rule, 'endpoint-gone');
    assert.deepEqual(byPattern['**/old'].findings.filter((f) => f.severity !== 'low'), [], 'redirects are followed');
    assert.match(byPattern['**/api/pay'].skipped, /POST mock/);
    assert.match(byPattern['**/api/items/*'].skipped, /wildcard/);
    const report = renderMockReport(checks, base, filesScanned);
    assert.equal(report.status, 'DRIFT');
    assert.match(report.text, /## ⚠️ DRIFT — 2 of 4 mock\(s\)/);
    assert.match(report.text, /`items\[\]\.price` is a \*\*number\*\* in the mock but a \*\*string\*\*/);
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
