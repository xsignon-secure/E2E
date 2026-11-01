/**
 * "Ask before changing files": tools that write to the project ask the
 * person first when the client can show a form (MCP elicitation). Driven
 * here end to end with the official client SDK on both protocol eras: the
 * 2026-07-28 multi-round-trip retry and the 2025 server-to-client request.
 * quarantine add is the probe because it writes a file without needing
 * Playwright or a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../dist/server.js';
import { confirmMode, confirmationKey, supportsFormElicitation } from '../dist/utils/confirm.js';

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-mcp-confirm-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'confirm-fixture', private: true }));
  writeFileSync(path.join(root, 'playwright.config.ts'), 'export default {};\n');
  return root;
}

async function connect(root, { mode, elicit, answer }) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer({ projectRoot: root }), { transport: serverSide });
  const client = new Client(
    { name: 'confirm-test', version: '1.0.0' },
    { versionNegotiation: { mode }, capabilities: elicit ? { elicitation: { form: {} } } : {} },
  );
  const asked = [];
  if (elicit) {
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params.message);
      return answer;
    });
  }
  await client.connect(clientSide);
  return {
    client,
    asked,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

const ADD = { action: 'add', file: 'tests/cart.spec.ts', title: 'adds an item', owner: 'ann', reason: 'race on the cart badge' };

function quarantined(root) {
  const file = path.join(root, 'playwright-quarantine.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).entries : [];
}

test('PW_MCP_CONFIRM_WRITES parses to auto, always or off', () => {
  assert.equal(confirmMode(undefined), 'auto');
  assert.equal(confirmMode(''), 'auto');
  assert.equal(confirmMode('off'), 'off');
  assert.equal(confirmMode('0'), 'off');
  assert.equal(confirmMode('ALWAYS'), 'always');
  assert.equal(confirmMode('required'), 'always');
});

test('form elicitation support is read from the declared capabilities', () => {
  assert.equal(supportsFormElicitation(undefined), false);
  assert.equal(supportsFormElicitation({}), false);
  assert.equal(supportsFormElicitation({ elicitation: {} }), true, '2025-06-18 shape means form mode');
  assert.equal(supportsFormElicitation({ elicitation: { form: {} } }), true);
  assert.equal(supportsFormElicitation({ elicitation: { url: {} } }), false, 'URL-only clients cannot show the form');
});

test('an approval is bound to the exact change', () => {
  const a = confirmationKey('suggest-fix', { title: 'Apply?', detail: '- a\n+ b' });
  const b = confirmationKey('suggest-fix', { title: 'Apply?', detail: '- a\n+ c' });
  assert.notEqual(a, b);
  assert.equal(a, confirmationKey('suggest-fix', { title: 'Apply?', detail: '- a\n+ b' }));
});

for (const mode of [{ pin: '2026-07-28' }, 'legacy']) {
  const era = JSON.stringify(mode);

  test(`${era}: the person is asked, says yes, and the change is written`, async () => {
    const root = project();
    const { client, asked, close } = await connect(root, { mode, elicit: true, answer: { action: 'accept', content: { confirm: true } } });
    try {
      const result = await client.callTool({ name: 'quarantine', arguments: ADD });
      assert.equal(asked.length, 1, 'asked exactly once');
      assert.match(asked[0], /Quarantine tests\/cart\.spec\.ts › adds an item until/);
      assert.match(asked[0], /Owner: ann/);
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.status, 'added');
      assert.equal(quarantined(root).length, 1);
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${era}: the person says no, and nothing is written`, async () => {
    const root = project();
    const { client, asked, close } = await connect(root, { mode, elicit: true, answer: { action: 'accept', content: { confirm: false } } });
    try {
      const result = await client.callTool({ name: 'quarantine', arguments: ADD });
      assert.equal(asked.length, 1);
      assert.equal(result.structuredContent.declined, true);
      assert.match(result.content[0].text, /Nothing was written/);
      assert.deepEqual(quarantined(root), []);
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${era}: cancelling the question counts as no`, async () => {
    const root = project();
    const { client, close } = await connect(root, { mode, elicit: true, answer: { action: 'cancel' } });
    try {
      const result = await client.callTool({ name: 'quarantine', arguments: ADD });
      assert.equal(result.structuredContent.declined, true);
      assert.deepEqual(quarantined(root), []);
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${era}: a client without elicitation writes as before`, async () => {
    const root = project();
    const { client, close } = await connect(root, { mode, elicit: false });
    try {
      const result = await client.callTool({ name: 'quarantine', arguments: ADD });
      assert.equal(result.structuredContent.status, 'added');
      assert.equal(quarantined(root).length, 1);
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('PW_MCP_CONFIRM_WRITES=always refuses to write when the client cannot ask', async () => {
  const root = project();
  process.env.PW_MCP_CONFIRM_WRITES = 'always';
  const { client, close } = await connect(root, { mode: { pin: '2026-07-28' }, elicit: false });
  try {
    const result = await client.callTool({ name: 'quarantine', arguments: ADD });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cannot ask/);
    assert.deepEqual(quarantined(root), []);
  } finally {
    delete process.env.PW_MCP_CONFIRM_WRITES;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('PW_MCP_CONFIRM_WRITES=off never asks', async () => {
  const root = project();
  process.env.PW_MCP_CONFIRM_WRITES = 'off';
  const { client, asked, close } = await connect(root, { mode: { pin: '2026-07-28' }, elicit: true, answer: { action: 'decline' } });
  try {
    const result = await client.callTool({ name: 'quarantine', arguments: ADD });
    assert.equal(asked.length, 0);
    assert.equal(result.structuredContent.status, 'added');
  } finally {
    delete process.env.PW_MCP_CONFIRM_WRITES;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only actions never ask', async () => {
  const root = project();
  const { client, asked, close } = await connect(root, { mode: { pin: '2026-07-28' }, elicit: true, answer: { action: 'decline' } });
  try {
    const result = await client.callTool({ name: 'quarantine', arguments: { action: 'list' } });
    assert.equal(asked.length, 0);
    assert.equal(result.structuredContent.status, 'listed');
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
