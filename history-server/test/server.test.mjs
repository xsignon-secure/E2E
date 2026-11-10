import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileStore } from '../lib/store.mjs';

const TOKEN = 'team_token_server_test';
const run = (at) => ({ v: 1, at, source: 'ci', command: 'npx playwright test', ok: true, durationMs: 5, stats: null, tests: [{ file: 'a.spec.ts', title: 't', status: 'passed' }] });

test('fileStore keeps runs across restarts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-'));
  try {
    const first = await fileStore(dir);
    assert.equal(await first.addRuns('web', 'acme/shop', [run('2026-10-20T10:00:00.000Z'), run('2026-10-21T10:00:00.000Z')]), 2);
    const second = await fileStore(dir);
    assert.deepEqual((await second.listRuns('web', 'acme/shop', 10)).map((r) => r.at), ['2026-10-20T10:00:00.000Z', '2026-10-21T10:00:00.000Z']);
    assert.equal(await second.projectCount('other'), 0);
    assert.equal(await second.deleteProject('web', 'acme/shop'), 2);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'history.json'), 'utf8')), { web: {}, other: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileStore saves again after a failed save', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-fail-'));
  const file = path.join(dir, 'history.json');
  try {
    const store = await fileStore(dir);
    // A non-empty directory where history.json goes makes the rename fail.
    mkdirSync(file);
    writeFileSync(path.join(file, 'block'), 'x');
    await assert.rejects(store.addRuns('web', 'acme/shop', [run('2026-10-20T10:00:00.000Z')]));
    rmSync(file, { recursive: true, force: true });
    assert.equal(await store.addRuns('web', 'acme/shop', [run('2026-10-21T10:00:00.000Z')]), 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).web['acme/shop'].length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server.mjs serves the API and the dashboard over plain HTTP', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-srv-'));
  const { startServer } = await import('../server.mjs');
  const server = await startServer({ port: 0, host: '127.0.0.1', env: { HISTORY_TOKENS: `web:${TOKEN}`, HISTORY_DATA_DIR: dir } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/projects`)).status, 401);
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const up = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ project: 'acme/shop', runs: [run('2026-10-20T10:00:00.000Z')] }) });
    assert.deepEqual(await up.json(), { project: 'acme/shop', received: 1, stored: 1, skipped: 0 });
    const projects = await (await fetch(`${base}/api/v1/projects`, { headers: auth })).json();
    assert.equal(projects.projects[0].project, 'acme/shop');
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Team test history/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
