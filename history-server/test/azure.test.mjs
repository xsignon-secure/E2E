import { test } from 'node:test';
import assert from 'node:assert/strict';
import azure from '@azure/functions';

const { app, HttpRequest } = azure;

const KEY = 'team_token_azure_test';
process.env.HISTORY_TOKENS = KEY;
delete process.env.DATABASE_URL;
delete process.env.HISTORY_DATA_DIR;

// Capture the registrations instead of starting the Functions host.
const routes = {};
app.http = (name, options) => { routes[name] = options; };
await import('../azure/functions.mjs');

const call = (name, method, path, { params = {}, key, body } = {}) =>
  routes[name].handler(
    new HttpRequest({
      method,
      url: `https://history.azurewebsites.net${path}`,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? { string: JSON.stringify(body) } : undefined,
      params,
    }),
    {},
  );

test('Azure entry registers the API and the dashboard with Vercel-compatible routes', () => {
  assert.equal(routes.api.route, 'api/v1/{*path}');
  assert.equal(routes.api.authLevel, 'anonymous');
  assert.deepEqual(routes.api.methods, ['GET', 'POST', 'DELETE']);
  assert.equal(routes.dashboard.route, '{file?}');
});

test('Azure entry serves the API through the shared handler', async () => {
  const health = await call('api', 'GET', '/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');

  assert.equal((await call('api', 'GET', '/api/v1/projects')).status, 401);

  const run = { v: 1, at: '2026-10-20T10:00:00Z', source: 'ci', command: 'npx playwright test', ok: true, durationMs: 5, stats: null, tests: [{ file: 'a.spec.ts', title: 't', status: 'passed' }] };
  const up = await call('api', 'POST', '/api/v1/runs', { key: KEY, body: { project: 'acme/shop', runs: [run] } });
  assert.equal(up.status, 200, up.body);
  assert.equal(JSON.parse(up.body).stored, 1);

  const projects = JSON.parse((await call('api', 'GET', '/api/v1/projects', { key: KEY })).body);
  assert.deepEqual(projects.projects.map((p) => [p.project, p.runs]), [['acme/shop', 1]]);

  assert.equal((await call('api', 'DELETE', '/api/v1/projects?project=acme/shop', { key: KEY })).status, 200);
});

test('Azure entry serves the dashboard files and nothing else', async () => {
  const index = await call('dashboard', 'GET', '/', { params: {} });
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.body, /Team test history/);
  assert.match(index.headers['content-security-policy'], /default-src 'self'/);

  const js = await call('dashboard', 'GET', '/app.js', { params: { file: 'app.js' } });
  assert.match(js.headers['content-type'], /javascript/);

  assert.equal((await call('dashboard', 'GET', '/package.json', { params: { file: 'package.json' } })).status, 404);
  assert.equal((await call('dashboard', 'GET', '/..%2Fpackage.json', { params: { file: '../package.json' } })).status, 404);
});
