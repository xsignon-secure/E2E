/**
 * Token savings: tools/list advertises compact input schemas while the
 * server still enforces the full ones, and inspect-page's locator map
 * collapses repeated blocks and drops redundant alternatives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createMcpHttpHandler } from '../dist/http.js';
import { compactJsonSchema, withCompactJsonSchema } from '../dist/utils/compact-schema.js';
import { renderLocatorMap, renderLocatorLine } from '../dist/utils/locator-map.js';

const TOKEN = 'token-savings-test-token-0123456789';

async function rpc(handler, id, method, params) {
  const res = await handler.fetch(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  const text = await res.text();
  return text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5));
}

test('compactJsonSchema drops limits but keeps property names that look like keywords', () => {
  const out = compactJsonSchema({
    $schema: 'x',
    type: 'object',
    additionalProperties: {},
    properties: {
      maxLength: { type: 'integer', minimum: 1, maximum: 9 },
      list: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 5 } },
      headers: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'string' } },
    },
  });
  assert.deepEqual(out, {
    type: 'object',
    properties: {
      maxLength: { type: 'integer', minimum: 1, maximum: 9 },
      list: { type: 'array', items: { type: 'string' } },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
    },
  });
});

test('withCompactJsonSchema lists the compact schema but validates the full one', async () => {
  const schema = withCompactJsonSchema(z.object({ name: z.string().max(3) }));
  const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  assert.equal(json.properties.name.maxLength, undefined);
  const bad = await schema['~standard'].validate({ name: 'toolong' });
  assert.ok(bad.issues && bad.issues.length > 0);
  const good = await schema['~standard'].validate({ name: 'ok' });
  assert.deepEqual(good.value, { name: 'ok' });
});

test('tools/list carries no length limits, and calls are still checked against them', async () => {
  const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [] });
  try {
    const list = await rpc(handler, 1, 'tools/list', {});
    const text = JSON.stringify(list.result.tools.map((tool) => tool.inputSchema));
    for (const keyword of ['"maxLength"', '"minLength"', '"maxItems"', '"propertyNames"', '"$schema"']) {
      assert.ok(!text.includes(keyword), `${keyword} still listed`);
    }
    const call = await rpc(handler, 2, 'tools/call', { name: 'get-failure', arguments: { index: 'not-a-number' } });
    const result = call.result ?? {};
    assert.ok(call.error || result.isError, 'invalid arguments are refused');
  } finally {
    await handler.close().catch(() => undefined);
  }
});

const role = (r, name) => [{ method: 'getByRole', args: [r, ...(name ? [{ name }] : [])] }];
const testId = (id) => [{ method: 'getByTestId', args: [id] }];
const text = (t) => [{ method: 'getByText', args: [t] }];

function card(n, name) {
  return [
    { selector: `article:nth-of-type(${n})`, tag: 'article', classes: [], attributes: {}, visible: true, locators: [testId(`product-${n}`)] },
    { selector: `article:nth-of-type(${n}) > h3`, tag: 'h3', role: 'heading', name, classes: [], attributes: {}, visible: true, locators: [role('heading', name), text(name)] },
    { selector: `article:nth-of-type(${n}) > button`, tag: 'button', role: 'button', name: 'Add to cart', classes: [], attributes: {}, visible: true, locators: [testId(`add-${n}`)] },
  ];
}

test('the locator map shows a repeated block once and names the rest', () => {
  const names = ['Trail Runner', 'Rain Shell', 'Wool Beanie', 'Canvas Tote'];
  const elements = [
    { selector: 'h1', tag: 'h1', role: 'heading', name: 'Shop', classes: [], attributes: {}, visible: true, locators: [role('heading', 'Shop')] },
    ...names.flatMap((name, i) => card(i + 1, name)),
    { selector: '#checkout', tag: 'button', role: 'button', name: 'Checkout', classes: [], attributes: {}, visible: true, locators: [role('button', 'Checkout'), testId('checkout-btn')] },
  ];
  const lines = renderLocatorMap(elements);
  assert.equal(lines.length, 1 + 3 + 1 + 1);
  assert.match(lines[4], /^5–13\. ↳ 3 more blocks like 2–4: .*"Rain Shell", "Wool Beanie", "Canvas Tote"/);
  assert.equal(lines[5], "14. `getByRole('button', { name: 'Checkout' })` — button \"Checkout\" · also `getByTestId('checkout-btn')`");
});

test('short runs are listed in full', () => {
  const links = ['A', 'B', 'C', 'D'].map((name) => ({ selector: name, tag: 'a', role: 'link', name, classes: [], attributes: {}, visible: true, locators: [role('link', name)] }));
  assert.equal(renderLocatorMap(links).length, 4);
});

test('text and CSS alternatives are dropped, a test id alternative stays', () => {
  const line = renderLocatorLine(
    { selector: 'h3', tag: 'h3', role: 'heading', name: 'Hi', classes: [], attributes: {}, visible: true, locators: [role('heading', 'Hi'), text('Hi'), [{ method: 'locator', args: ['h3'] }]] },
    1,
  );
  assert.equal(line, "1. `getByRole('heading', { name: 'Hi' })` — heading \"Hi\"");
});

// ---------------------------------------------------------------------------
// PW_MCP_TOOLS=auto: start with the core loop, load the rest on request.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveToolSelection, TOOL_PROFILES } from '../dist/server.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function stdioClient(args) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, LOG_LEVEL: 'silent' } });
  const pending = new Map();
  const notifications = [];
  let buffer = '';
  let id = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) pending.get(msg.id)?.(msg);
        else notifications.push(msg.method);
      } catch {
        /* not JSON */
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return {
    notifications,
    request,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    close: () => child.kill(),
  };
}

test('resolveToolSelection: auto starts with core, or with the listed tools', () => {
  assert.deepEqual(new Set(resolveToolSelection('auto').tools), new Set(TOOL_PROFILES.core));
  assert.equal(resolveToolSelection('auto').lazy, true);
  const withInspect = resolveToolSelection('auto,inspect-page');
  assert.deepEqual(withInspect.tools, ['inspect-page']);
  assert.equal(resolveToolSelection('core').lazy, undefined);
});

test('--tools=auto lists core + load-tools, and load-tools turns on a profile with one list_changed', async () => {
  const client = stdioClient(['--tools=auto']);
  try {
    await client.init();
    const first = (await client.request('tools/list', {})).result.tools.map((tool) => tool.name);
    assert.deepEqual(new Set(first), new Set([...TOOL_PROFILES.core, 'load-tools']));

    const hidden = await client.request('tools/call', { name: 'inspect-page', arguments: { url: 'http://example.test' } });
    assert.ok(hidden.error || hidden.result?.isError, 'a hidden tool cannot be called before it is loaded');

    const loaded = await client.request('tools/call', { name: 'load-tools', arguments: { load: ['inspect', 'nope'] } });
    const text = loaded.result.content[0].text;
    assert.match(text, /Loaded: .*`inspect-page`/);
    assert.match(text, /Unknown: `nope`/);
    assert.ok(!loaded.result.isError, 'a partly unknown request still loads the known tools');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.notifications.filter((method) => method === 'notifications/tools/list_changed').length, 1);

    const after = (await client.request('tools/list', {})).result.tools.map((tool) => tool.name);
    for (const name of TOOL_PROFILES.inspect) assert.ok(after.includes(name), `${name} listed after loading`);

    const again = await client.request('tools/call', { name: 'load-tools', arguments: { load: ['inspect'] } });
    assert.match(again.result.content[0].text, /already loaded/);
  } finally {
    client.close();
  }
});

test('--tools core (two args, as client configs often write it) is honoured too', async () => {
  const client = stdioClient(['--tools', 'core']);
  try {
    await client.init();
    const listed = (await client.request('tools/list', {})).result.tools.map((tool) => tool.name);
    assert.deepEqual(new Set(listed), new Set(TOOL_PROFILES.core));
  } finally {
    client.close();
  }
});

test('the HTTP bridge lists every tool for PW_MCP_TOOLS=auto (it cannot keep loaded tools)', async () => {
  const previous = process.env.PW_MCP_TOOLS;
  process.env.PW_MCP_TOOLS = 'auto';
  const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [] });
  try {
    const names = (await rpc(handler, 1, 'tools/list', {})).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('inspect-page'));
    assert.ok(!names.includes('load-tools'));
  } finally {
    if (previous === undefined) delete process.env.PW_MCP_TOOLS;
    else process.env.PW_MCP_TOOLS = previous;
    await handler.close().catch(() => undefined);
  }
});
