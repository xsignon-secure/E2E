/**
 * Shared history client: opt-in only (no token → no network), upload of
 * recorded runs, and analyze-history merging the server's runs. A small fake
 * of the history server API stands in for it. The 0.7/0.8 PW_MCP_PRO_* names
 * keep working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeHistoryTool } from '../dist/tools/analyze-history.js';
import { createToolStore } from '../dist/tools/shared.js';
import { mergeRuns, historyProjectName, historySettings } from '../dist/utils/history-client.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const ctxFor = (root) => ({ logger: silent, store: createToolStore(), projectRoot: root });
const textOf = (response) => response.content.map((c) => c.text).join('\n');
const KEY = 'pro_test_key_123';

const entry = (at, status, title = 'checkout pays') => ({
  v: 1,
  at,
  source: 'run-test',
  command: 'npx playwright test',
  ok: status === 'passed',
  durationMs: 10,
  stats: null,
  tests: [{ file: 'tests/checkout.spec.ts', title, status }],
});

function fakeCloud(seed = {}) {
  const projects = new Map(Object.entries(seed));
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      const send = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'This Pro key is not active', hint: 'Renew it.' });
      if (req.method === 'POST' && url.pathname === '/api/v1/runs') {
        const { project, runs } = JSON.parse(body);
        const list = projects.get(project) ?? [];
        const before = list.length;
        for (const r of runs) if (!list.some((x) => x.at === r.at)) list.push(r);
        projects.set(project, list);
        return send(200, { project, received: runs.length, stored: list.length - before, skipped: runs.length - (list.length - before) });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/runs') {
        const list = [...(projects.get(url.searchParams.get('project')) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
        return send(200, { runs: list.slice(-Number(url.searchParams.get('limit'))) });
      }
      send(404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, projects, close: () => new Promise((r) => server.close(r)) })),
  );
}

function project(entries) {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-pro-'));
  mkdirSync(path.join(root, '.playwright-e2e-mcp'));
  writeFileSync(path.join(root, '.playwright-e2e-mcp', 'history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function cli(args, root, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.resolve('dist/index.js'), ...args], { cwd: root, env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}` }),
    );
  });
}

test('without a token nothing is configured and the history stays local', async () => {
  assert.equal(historySettings({}), undefined);
  assert.throws(() => historySettings({ PW_MCP_HISTORY_TOKEN: KEY }), /PW_MCP_HISTORY_URL is not/);
  assert.throws(() => historySettings({ PW_MCP_PRO_KEY: KEY }), /PW_MCP_HISTORY_URL is not/);
  assert.deepEqual(historySettings({ PW_MCP_HISTORY_TOKEN: KEY, PW_MCP_HISTORY_URL: 'https://history.example.com/' }), { key: KEY, url: 'https://history.example.com' });
  assert.deepEqual(historySettings({ PW_MCP_HISTORY_TOKEN: KEY, PW_MCP_HISTORY_URL: 'https://new.example.com', PW_MCP_PRO_KEY: 'old', PW_MCP_PRO_URL: 'https://old.example.com' }), { key: KEY, url: 'https://new.example.com' });
  assert.throws(() => historySettings({ PW_MCP_PRO_KEY: KEY, PW_MCP_PRO_URL: 'http://pro.example.com' }), /https/);
  assert.deepEqual(historySettings({ PW_MCP_PRO_KEY: ` ${KEY} `, PW_MCP_PRO_URL: 'https://pro.example.com/' }), { key: KEY, url: 'https://pro.example.com' });

  const root = project([entry('2026-10-20T10:00:00.000Z', 'passed'), entry('2026-10-21T10:00:00.000Z', 'failed')]);
  try {
    await withEnv({ PW_MCP_PRO_KEY: undefined, PW_MCP_PRO_URL: undefined, PW_MCP_HISTORY_TOKEN: undefined, PW_MCP_HISTORY_URL: undefined }, async () => {
      const local = await analyzeHistoryTool.handler({ view: 'test', test: 'checkout' }, ctxFor(root));
      assert.doesNotMatch(textOf(local), /history server/);
      const cloud = await analyzeHistoryTool.handler({ source: 'cloud' }, ctxFor(root));
      assert.equal(cloud.isError, true);
      assert.match(textOf(cloud), /needs a shared history server/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upload sends only new runs, under the repository name, and is safe to repeat', async () => {
  const cloud = await fakeCloud();
  const root = project([entry('2026-10-20T10:00:00.000Z', 'passed'), entry('2026-10-21T10:00:00.000Z', 'failed')]);
  const env = { PW_MCP_HISTORY_TOKEN: KEY, PW_MCP_HISTORY_URL: cloud.url, GITHUB_REPOSITORY: 'acme/shop', PW_MCP_HISTORY_PROJECT: '', PW_MCP_PRO_PROJECT: '' };
  try {
    const first = await cli(['upload'], root, env);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Uploaded 2 run\(s\) to acme\/shop: 2 stored/);
    assert.equal(cloud.requests[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.playwright-e2e-mcp', 'history-upload.json'), 'utf8')).lastAt, '2026-10-21T10:00:00.000Z');

    const nothing = await cli(['upload'], root, env);
    assert.match(nothing.out, /Nothing new/);
    assert.equal(cloud.requests.length, 1);

    writeFileSync(path.join(root, '.playwright-e2e-mcp', 'history.jsonl'), JSON.stringify(entry('2026-10-22T10:00:00.000Z', 'passed')) + '\n', { flag: 'a' });
    const next = await cli(['upload', '--project', 'acme/other'], root, env);
    assert.match(next.out, /Uploaded 1 run\(s\) to acme\/other/);
    assert.equal(cloud.requests[1].body.runs.length, 1);

    const all = await cli(['upload', '--all'], root, env);
    assert.match(all.out, /Uploaded 3 run\(s\) to acme\/shop: 1 stored, 2 already there/);

    const badKey = await cli(['upload', '--all'], root, { ...env, PW_MCP_HISTORY_TOKEN: 'wrong_key_12345' });
    assert.equal(badKey.code, 1);
    assert.match(badKey.out, /not active/);
    const noKey = await cli(['upload'], root, { ...env, PW_MCP_HISTORY_TOKEN: '' });
    assert.equal(noKey.code, 2);
    assert.match(noKey.out, /nothing is sent anywhere/);
  } finally {
    await cloud.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze-history merges CI runs from the history server with local ones (old PW_MCP_PRO_* names)', async () => {
  const ciRuns = ['2026-10-18', '2026-10-19', '2026-10-22'].map((d, i) => entry(`${d}T10:00:00.000Z`, i === 1 ? 'failed' : 'passed'));
  const cloud = await fakeCloud({ 'acme/shop': ciRuns });
  const local = [entry('2026-10-20T10:00:00.000Z', 'failed'), entry('2026-10-21T10:00:00.000Z', 'passed')];
  const root = project(local);
  try {
    await withEnv({ PW_MCP_PRO_KEY: KEY, PW_MCP_PRO_URL: cloud.url, PW_MCP_PRO_PROJECT: 'acme/shop' }, async () => {
      const both = await analyzeHistoryTool.handler({ view: 'test', test: 'checkout' }, ctxFor(root));
      const text = textOf(both);
      assert.match(text, /2 local run\(s\) \+ 3 shared run\(s\) for `acme\/shop`/);
      assert.match(text, /`PFFPP`/, 'five runs in time order');

      const onlyLocal = await analyzeHistoryTool.handler({ view: 'test', test: 'checkout', source: 'local' }, ctxFor(root));
      assert.match(textOf(onlyLocal), /`FP`/);
    });
    await cloud.close();
    await withEnv({ PW_MCP_PRO_KEY: KEY, PW_MCP_PRO_URL: cloud.url, PW_MCP_PRO_PROJECT: 'acme/shop' }, async () => {
      const down = await analyzeHistoryTool.handler({ view: 'test', test: 'checkout' }, ctxFor(root));
      assert.match(textOf(down), /local only; the history server failed/);
      const cloudOnly = await analyzeHistoryTool.handler({ source: 'cloud' }, ctxFor(root));
      assert.equal(cloudOnly.isError, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeRuns drops duplicates and keeps the newest runs; project names are safe', async () => {
  const a = entry('2026-10-20T10:00:00.000Z', 'passed');
  const b = entry('2026-10-21T10:00:00.000Z', 'failed');
  const c = entry('2026-10-22T10:00:00.000Z', 'passed');
  assert.deepEqual(mergeRuns([a, b], [b, c], 2).map((e) => e.at), [b.at, c.at]);
  const root = mkdtempSync(path.join(tmpdir(), 'pw-pro-name-'));
  try {
    assert.equal(await historyProjectName(root, { PW_MCP_PRO_PROJECT: 'team/app' }), 'team/app');
    assert.equal(await historyProjectName(root, { PW_MCP_PRO_PROJECT: '../evil', GITHUB_REPOSITORY: 'acme/shop' }), 'acme/shop');
    assert.equal(await historyProjectName(root, {}), path.basename(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
