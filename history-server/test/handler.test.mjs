import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRun, createHandler } from '../lib/handler.mjs';
import { parseTokens, tokenFingerprint, tokenValidator } from '../lib/tokens.mjs';
import { LIMITS, memoryStore } from '../lib/store.mjs';
import { summarize } from '../lib/summary.mjs';

const KEY_A = 'team_token_aaaaaaaa';
const KEY_B = 'team_token_bbbbbbbb';
const setup = () => createHandler({ store: memoryStore(), validate: tokenValidator({ HISTORY_TOKENS: `web:${KEY_A},${KEY_B}` }) });

const run = (at, statuses, extra = {}) => ({
  v: 1,
  at,
  source: 'ci',
  command: 'npx playwright test',
  ok: Object.values(statuses).every((s) => s === 'passed'),
  durationMs: 1000,
  stats: null,
  tests: Object.entries(statuses).map(([title, status]) => ({ file: 'tests/a.spec.ts', title, status, ...(status === 'failed' ? { msg: `boom ${title}` } : {}) })),
  ...extra,
});

const call = (handle, method, path, { key = KEY_A, body } = {}) =>
  handle(
    new Request(`https://history.test${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  ).then(async (r) => ({ status: r.status, body: await r.json() }));

test('health needs no key; everything else needs an active one', async () => {
  const handle = setup();
  assert.equal((await call(handle, 'GET', '/api/v1/health', { key: null })).status, 200);
  assert.equal((await call(handle, 'GET', '/api/v1/projects', { key: null })).status, 401);
  const bad = await call(handle, 'GET', '/api/v1/projects', { key: 'not-a-real-key-123' });
  assert.equal(bad.status, 401);
  assert.match(bad.body.hint, /HISTORY_TOKENS/);
});

test('upload stores runs once, lists them oldest first and summarizes them', async () => {
  const handle = setup();
  const runs = [
    run('2026-10-20T10:00:00Z', { stable: 'passed', flaky: 'passed', dead: 'passed' }),
    run('2026-10-21T10:00:00Z', { stable: 'passed', flaky: 'failed', dead: 'failed' }),
    run('2026-10-22T10:00:00Z', { stable: 'passed', flaky: 'passed', dead: 'failed' }),
    run('2026-10-23T10:00:00Z', { stable: 'passed', flaky: 'flaky', dead: 'failed' }, { commit: 'abc1234', buildUrl: 'https://ci.example/1' }),
  ];
  const up = await call(handle, 'POST', '/api/v1/runs', { body: { project: 'acme/shop', runs: [runs[2], runs[0], runs[3], runs[1]] } });
  assert.deepEqual(up.body, { project: 'acme/shop', received: 4, stored: 4, skipped: 0 });
  const again = await call(handle, 'POST', '/api/v1/runs', { body: { project: 'acme/shop', runs } });
  assert.equal(again.body.stored, 0);

  const list = await call(handle, 'GET', '/api/v1/runs?project=acme/shop&limit=3');
  assert.deepEqual(list.body.runs.map((r) => r.at), ['2026-10-21T10:00:00.000Z', '2026-10-22T10:00:00.000Z', '2026-10-23T10:00:00.000Z']);
  assert.equal(list.body.runs[2].commit, 'abc1234');

  const summary = await call(handle, 'GET', '/api/v1/summary?project=acme/shop');
  assert.equal(summary.body.runs, 4);
  assert.deepEqual(summary.body.flaky.map((t) => t.title), ['flaky']);
  assert.deepEqual(summary.body.broken.map((t) => t.title), ['dead']);
  assert.equal(summary.body.broken[0].lastError, 'boom dead');

  const projects = await call(handle, 'GET', '/api/v1/projects');
  assert.deepEqual(projects.body.projects, [{ project: 'acme/shop', runs: 4, lastAt: '2026-10-23T10:00:00.000Z' }]);
});

test("one key never sees or deletes another key's runs", async () => {
  const handle = setup();
  await call(handle, 'POST', '/api/v1/runs', { body: { project: 'acme/shop', runs: [run('2026-10-20T10:00:00Z', { a: 'passed' })] } });
  assert.deepEqual((await call(handle, 'GET', '/api/v1/runs?project=acme/shop', { key: KEY_B })).body.runs, []);
  assert.equal((await call(handle, 'DELETE', '/api/v1/projects?project=acme/shop', { key: KEY_B })).body.deleted, 0);
  assert.equal((await call(handle, 'GET', '/api/v1/runs?project=acme/shop')).body.runs.length, 1);
  assert.equal((await call(handle, 'DELETE', '/api/v1/projects?project=acme/shop')).body.deleted, 1);
  assert.deepEqual((await call(handle, 'GET', '/api/v1/projects')).body.projects, []);
});

test('bad input is refused with a reason', async () => {
  const handle = setup();
  assert.equal((await call(handle, 'POST', '/api/v1/runs', { body: { project: '../etc', runs: [] } })).status, 400);
  assert.equal((await call(handle, 'POST', '/api/v1/runs', { body: { project: 'ok', runs: 'nope' } })).status, 400);
  assert.equal((await call(handle, 'POST', '/api/v1/runs', { body: { project: 'ok', runs: Array(201).fill({}) } })).status, 413);
  assert.equal((await call(handle, 'GET', '/api/v1/runs')).status, 400);
  assert.equal((await call(handle, 'PUT', '/api/v1/runs')).status, 405);
  const junk = await call(handle, 'POST', '/api/v1/runs', { body: { project: 'ok', runs: [{ v: 2 }, null, run('not a date', {}), run('2026-10-20T10:00:00Z', { a: 'passed' })] } });
  assert.deepEqual([junk.body.stored, junk.body.skipped], [1, 3]);
});

test('the project limit applies to new projects only', async () => {
  const handle = setup();
  for (let i = 0; i < LIMITS.projects; i += 1) {
    await call(handle, 'POST', '/api/v1/runs', { body: { project: `p${i}`, runs: [run('2026-10-20T10:00:00Z', { a: 'passed' })] } });
  }
  assert.equal((await call(handle, 'POST', '/api/v1/runs', { body: { project: 'one-more', runs: [] } })).status, 403);
  assert.equal((await call(handle, 'POST', '/api/v1/runs', { body: { project: 'p0', runs: [run('2026-10-21T10:00:00Z', { a: 'passed' })] } })).status, 200);
});

test('cleanRun keeps known fields, clips sizes and drops the rest', () => {
  const cleaned = cleanRun({ ...run('2026-10-20T10:00:00Z', { a: 'failed' }), secret: 'x', buildUrl: 'javascript:alert(1)', commit: 'not-a-sha', tests: [{ file: 'f', title: 't', status: 'weird', msg: 'm'.repeat(5000), extra: 1 }] });
  assert.equal(cleaned.secret, undefined);
  assert.equal(cleaned.buildUrl, undefined);
  assert.equal(cleaned.commit, undefined);
  assert.deepEqual(Object.keys(cleaned.tests[0]).sort(), ['file', 'msg', 'status', 'title']);
  assert.equal(cleaned.tests[0].status, 'unknown');
  assert.equal(cleaned.tests[0].msg.length, 1000);
  assert.equal(cleanRun(run('2099-01-01T00:00:00Z', {})), null);
});

test('tokens: named and bare entries, bad entries refused, no token in the team name', async () => {
  assert.deepEqual(parseTokens(`web:${KEY_A}, ${KEY_B}`).map((e) => e.team), ['web', `token-${tokenFingerprint(KEY_B)}`]);
  assert.throws(() => parseTokens('web:short'), /16\+ characters/);
  assert.throws(() => parseTokens(`bad team:${KEY_A}`), /not a valid team name/);
  assert.throws(() => tokenValidator({}), /HISTORY_TOKENS is not set/);
  const validate = tokenValidator({ HISTORY_TOKENS: `web:${KEY_A},${KEY_B}` });
  assert.deepEqual(await validate(KEY_A), { ok: true, team: 'web' });
  assert.equal((await validate(KEY_B)).team.includes(KEY_B), false);
  assert.equal((await validate('team_token_cccccccc')).ok, false);
  assert.equal((await validate('short')).ok, false);
  assert.equal(tokenFingerprint(KEY_A).length, 16);
});

test('summarize: a test failing in every recent run is broken, one that flips is flaky', () => {
  const s = summarize([run('2026-10-20T10:00:00Z', { x: 'failed', y: 'passed' }), run('2026-10-21T10:00:00Z', { x: 'failed', y: 'failed' }), run('2026-10-22T10:00:00Z', { x: 'failed', y: 'passed' })]);
  assert.deepEqual(s.broken.map((t) => t.title), ['x']);
  assert.deepEqual(s.flaky.map((t) => t.title), ['y']);
  assert.equal(s.passRate, 0);
});
