/**
 * Structured results: tools that agents chain declare an output schema,
 * their builders produce data that schema accepts, errors carry a
 * structured error, and PW_MCP_OUTPUT_SCHEMAS=0 drops the schemas from
 * tools/list without changing the results.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpHandler } from '../dist/http.js';
import { outputSchemaFor, runData, toolOutputSchema } from '../dist/tools/structured.js';
import { toolError, toolText } from '../dist/tools/shared.js';

const TOKEN = 'structured-test-token-0123456789';

async function listTools() {
  const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [] });
  try {
    const res = await handler.fetch(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    const text = await res.text();
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5));
    return json.result.tools;
  } finally {
    await handler.close().catch(() => undefined);
  }
}

const sampleRun = {
  ok: false,
  exitCode: 1,
  signalName: null,
  durationMs: 1234.6,
  timedOut: false,
  killed: false,
  partial: false,
  stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 2, duration: 1200 },
  failures: [
    {
      file: 'tests/fail.spec.ts',
      line: 9,
      title: 'checkout › saves',
      status: 'failed',
      failureKind: 'timeout',
      message: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
      tracePath: '/tmp/trace.zip',
    },
  ],
  stdoutTail: '',
  stderrTail: '',
  truncatedOutput: false,
  command: 'npx playwright test',
};

test('runData summarises a run in the shape the schema accepts', () => {
  const run = runData(sampleRun);
  assert.deepEqual(
    { passed: run.passed, failed: run.failed, flaky: run.flaky, skipped: run.skipped, durationMs: run.durationMs },
    { passed: 3, failed: 1, flaky: 1, skipped: 2, durationMs: 1235 },
  );
  assert.equal(run.failures[0].kind, 'timeout');
  assert.equal(run.failures[0].message.split('\n').length, 6, 'long messages are cut to their first lines');
  assert.ok(outputSchemaFor('run-test').safeParse({ ok: false, run }).success);
});

test('only tools with their own fields declare a schema', () => {
  for (const name of ['run-test', 'get-run-status', 'get-failure', 'list-tests', 'diagnose-flaky', 'suggest-fix', 'audit-accessibility', 'audit-performance']) {
    assert.ok(outputSchemaFor(name), name);
  }
  assert.equal(outputSchemaFor('inspect-page'), undefined);
  // Each schema keeps only its tool's fields.
  assert.deepEqual(Object.keys(outputSchemaFor('suggest-fix').shape).sort(), ['applied', 'declined', 'error', 'fix', 'ok', 'verified']);
});

test('toolText and toolError carry the envelope', () => {
  assert.deepEqual(toolText('hi').structuredContent, { ok: true });
  assert.deepEqual(toolText('hi', { ok: false, total: 0 }).structuredContent, { ok: false, total: 0 });
  const error = toolError('TIMEOUT', 'took too long', 'raise timeoutMs');
  assert.equal(error.isError, true);
  assert.deepEqual(error.structuredContent, { ok: false, error: { kind: 'TIMEOUT', message: 'took too long', hint: 'raise timeoutMs' } });
  assert.ok(toolOutputSchema.safeParse(error.structuredContent).success);
});

test('tools/list advertises the schemas, and PW_MCP_OUTPUT_SCHEMAS=0 drops them', async () => {
  const tools = await listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName['run-test'].outputSchema.type, 'object');
  assert.ok(byName['run-test'].outputSchema.properties.run);
  assert.equal(byName['inspect-page'].outputSchema, undefined);

  process.env.PW_MCP_OUTPUT_SCHEMAS = '0';
  try {
    const lean = await listTools();
    assert.ok(lean.every((t) => t.outputSchema === undefined));
  } finally {
    delete process.env.PW_MCP_OUTPUT_SCHEMAS;
  }
});
