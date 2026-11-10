import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    await second.compact();
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'history.json'), 'utf8')), { web: {}, other: {} });
    assert.equal(readFileSync(path.join(dir, 'history.jsonl'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileStore saves again after a failed save', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-fail-'));
  const journal = path.join(dir, 'history.jsonl');
  try {
    const store = await fileStore(dir);
    // A non-empty directory where the journal goes makes the append fail.
    mkdirSync(journal);
    writeFileSync(path.join(journal, 'block'), 'x');
    await assert.rejects(store.addRuns('web', 'acme/shop', [run('2026-10-20T10:00:00.000Z')]));
    rmSync(journal, { recursive: true, force: true });
    assert.equal(await store.addRuns('web', 'acme/shop', [run('2026-10-21T10:00:00.000Z')]), 1);
    // The write after the failure saved both runs.
    const reopened = await fileStore(dir);
    assert.equal((await reopened.listRuns('web', 'acme/shop', 10)).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileStore appends uploads to a journal instead of rewriting the snapshot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-journal-'));
  const file = path.join(dir, 'history.json');
  const journal = path.join(dir, 'history.jsonl');
  try {
    const store = await fileStore(dir, { compactLines: 3 });
    await store.addRuns('web', 'a', [run('2026-10-20T10:00:00.000Z')]);
    await store.addRuns('web', 'a', [run('2026-10-20T10:00:00.000Z')]); // duplicate: nothing written
    await store.addRuns('web', 'b', [run('2026-10-21T10:00:00.000Z')]);
    assert.equal(existsSync(file), false, 'no snapshot rewrite per upload');
    assert.equal(readFileSync(journal, 'utf8').trim().split('\n').length, 2);
    await store.deleteProject('web', 'b');
    assert.equal(readFileSync(journal, 'utf8').trim().split('\n').length, 3);
    // The fourth write passes compactLines: snapshot rewritten, journal emptied.
    await store.addRuns('web', 'c', [run('2026-10-22T10:00:00.000Z')]);
    assert.equal(readFileSync(journal, 'utf8'), '');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).web).sort(), ['a', 'c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileStore replays the journal on start and skips a torn last line', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-history-replay-'));
  const journal = path.join(dir, 'history.jsonl');
  try {
    const first = await fileStore(dir);
    await first.addRuns('web', 'a', [run('2026-10-20T10:00:00.000Z')]);
    await first.addRuns('web', 'a', [run('2026-10-21T10:00:00.000Z')]);
    // A crash mid-append leaves half a line.
    appendFileSync(journal, '{"op":"add","team":"web","proj');
    const second = await fileStore(dir);
    assert.deepEqual((await second.listRuns('web', 'a', 10)).map((r) => r.at), ['2026-10-20T10:00:00.000Z', '2026-10-21T10:00:00.000Z']);
    assert.equal(readFileSync(journal, 'utf8'), '', 'start-up compacts the replayed journal');
    // Replaying the same journal over a snapshot that already has it changes nothing.
    writeFileSync(journal, `${JSON.stringify({ op: 'add', team: 'web', project: 'a', runs: [run('2026-10-20T10:00:00.000Z')] })}\n`);
    const third = await fileStore(dir);
    assert.equal((await third.listRuns('web', 'a', 10)).length, 2);
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
