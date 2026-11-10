/**
 * Fixes from the 2026-11-10 audit:
 * - CI artifact downloads are capped by the bytes actually read, not only by
 *   Content-Length (a chunked response has none).
 * - `playwright-e2e-mcp ci` keeps GITHUB_TOKEN / GH_TOKEN out of the test
 *   processes it starts, so PR-changed test code cannot read a write token.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCapped } from '../dist/utils/ci-artifacts.js';
import { childEnv, withholdFromChildren } from '../dist/utils/playwright-runner.js';

function chunked(chunks) {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), wasCancelled: () => cancelled };
}

test('readCapped returns a body under the cap', async () => {
  const { response } = chunked([Buffer.from('abc'), Buffer.from('def')]);
  assert.equal((await readCapped(response, 10)).toString(), 'abcdef');
});

test('readCapped stops a chunked body that passes the cap, with no Content-Length', async () => {
  const { response, wasCancelled } = chunked([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
  assert.equal(response.headers.get('content-length'), null);
  await assert.rejects(readCapped(response, 10), /too large/);
  assert.equal(wasCancelled(), true);
});

test('readCapped refuses a declared Content-Length over the cap before reading', async () => {
  const response = new Response('x'.repeat(20), { headers: { 'content-length': '20' } });
  await assert.rejects(readCapped(response, 10), /too large/);
});

test('withheld variables never reach children unless passed through', () => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, PW_MCP_PASSTHROUGH_ENV: process.env.PW_MCP_PASSTHROUGH_ENV };
  try {
    process.env.GH_TOKEN = 'ghs_write_token';
    process.env.GITHUB_TOKEN = 'ghs_write_token';
    delete process.env.PW_MCP_PASSTHROUGH_ENV;
    assert.equal(childEnv().GH_TOKEN, 'ghs_write_token', 'nothing is withheld by default');
    withholdFromChildren(['GITHUB_TOKEN', 'GH_TOKEN']);
    const env = childEnv({ FORCE_COLOR: '0' });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.FORCE_COLOR, '0');
    assert.ok(env.PATH, 'everything else still passes');
    assert.equal(process.env.GH_TOKEN, 'ghs_write_token', 'the parent keeps it for the PR review');
    process.env.PW_MCP_PASSTHROUGH_ENV = 'GITHUB_TOKEN';
    assert.equal(childEnv().GITHUB_TOKEN, 'ghs_write_token', 'a user can opt back in');
    assert.equal(childEnv().GH_TOKEN, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
