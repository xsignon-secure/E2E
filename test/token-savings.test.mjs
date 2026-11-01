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
