/**
 * MCP Apps: the interactive test report. The protocol side (tools point at
 * the ui:// view, the view is served with the MCP Apps MIME type) runs with
 * the official client SDK; the view itself runs in Chromium inside a small
 * fake host that speaks the MCP Apps postMessage protocol.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { chromium } from '@playwright/test';
import { createServer } from '../dist/server.js';
import { MCP_APP_MIME_TYPE, TEST_REPORT_URI, appMetaFor } from '../dist/apps/index.js';
import { TEST_REPORT_HTML } from '../dist/apps/test-report-html.js';

async function connect(mode = { pin: '2026-07-28' }) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer({ projectRoot: process.cwd() }), { transport: serverSide });
  const client = new Client({ name: 'apps-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(clientSide);
  return { client, close: async () => { await client.close(); await handle.close(); } };
}

for (const mode of [{ pin: '2026-07-28' }, 'legacy']) {
  test(`${JSON.stringify(mode)}: report tools point at the ui:// view and the view is served`, async () => {
    const { client, close } = await connect(mode);
    try {
      const { tools } = await client.listTools();
      for (const name of ['run-test', 'get-run-status', 'get-failure']) {
        const tool = tools.find((t) => t.name === name);
        assert.equal(tool._meta?.ui?.resourceUri, TEST_REPORT_URI, `${name} declares the view`);
        assert.equal(tool._meta?.['ui/resourceUri'], TEST_REPORT_URI, `${name} keeps the legacy key`);
      }
      assert.equal(tools.find((t) => t.name === 'list-tests')._meta?.ui, undefined, 'other tools have no view');

      const { resources } = await client.listResources();
      const listed = resources.find((r) => r.uri === TEST_REPORT_URI);
      assert.equal(listed?.mimeType, MCP_APP_MIME_TYPE);

      const read = await client.readResource({ uri: TEST_REPORT_URI });
      assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.match(read.contents[0].text, /^<!doctype html>/);
      assert.deepEqual(read.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    } finally {
      await close();
    }
  });
}

test('PW_MCP_APPS=0 turns the view off', async () => {
  process.env.PW_MCP_APPS = '0';
  try {
    assert.equal(appMetaFor('run-test'), undefined);
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.find((t) => t.name === 'run-test')._meta?.ui, undefined);
      const { resources } = await client.listResources();
      assert.equal(resources.some((r) => r.uri === TEST_REPORT_URI), false);
    } finally {
      await close();
    }
  } finally {
    delete process.env.PW_MCP_APPS;
  }
});

test('the view loads nothing from outside and never writes result text as HTML', () => {
  assert.doesNotMatch(TEST_REPORT_HTML, /<script[^>]+src=|<link[^>]+href=|https?:\/\//i);
  assert.doesNotMatch(TEST_REPORT_HTML, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

// ---- the view in a browser, inside a fake MCP Apps host ----

const RUN_RESULT = {
  content: [{ type: 'text', text: '## ❌ 1 failed' }],
  structuredContent: {
    ok: false,
    run: {
      passed: 4,
      failed: 1,
      flaky: 0,
      skipped: 1,
      durationMs: 5400,
      exitCode: 1,
      partial: false,
      failures: [
        {
          file: 'tests/cart.spec.ts',
          line: 42,
          title: 'adds <b>an item</b>',
          kind: 'assertion',
          message: 'expect(locator).toHaveText(expected)\n<img src=x onerror=alert(1)>',
        },
      ],
    },
  },
};

const HOST = `<!doctype html><html><body>
<iframe id="app" sandbox="allow-scripts" style="width:600px;height:500px;border:0"></iframe>
<script>
  window.sent = [];
  const frame = document.getElementById('app');
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    window.sent.push(msg);
    const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: msg.id, result }, '*');
    if (msg.method === 'ui/initialize') {
      reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'fake-host', version: '1' },
        hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: 'dark' } });
    } else if (msg.method === 'ui/notifications/initialized') {
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { testFiles: ['tests/cart.spec.ts'] } } }, '*');
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.RESULT }, '*');
    } else if (msg.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'details for ' + msg.params.arguments.index }],
        structuredContent: { ok: false, failure: { file: 'tests/cart.spec.ts', line: 42, title: 't', kind: 'assertion', message: 'm', expected: 'Total: 2', actual: 'Total: 1' } } });
    } else if (msg.method === 'ui/message') {
      reply({});
    }
  });
</script></body></html>`;

let browser;
try {
  // CHROMIUM_PATH: a local Chromium when Playwright's own build is not installed.
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
} catch {
  browser = undefined;
}

test('the report renders a run, and its buttons call tools and send messages through the host', { skip: !browser && 'Chromium is not installed' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(HOST);
    await page.evaluate(([result, html]) => {
      window.RESULT = result;
      document.getElementById('app').srcdoc = html;
    }, [RUN_RESULT, TEST_REPORT_HTML]);
    const app = page.frameLocator('#app');

    await app.getByText('1 failed', { exact: true }).waitFor();
    assert.equal(await app.locator('.stat.passed b').textContent(), '4');
    assert.equal(await app.locator('html').getAttribute('data-theme'), 'dark', 'host theme applied');
    // Text from the project is shown as text, not markup.
    assert.equal(await app.locator('.title').first().textContent(), 'adds <b>an item</b>assertion');
    assert.equal(await app.locator('img').count(), 0);
    assert.match(await app.locator('li.failure pre').first().textContent(), /<img src=x onerror=alert\(1\)>/);

    await app.getByRole('button', { name: 'Show details' }).click();
    await app.getByText('Total: 1').waitFor();
    await app.getByRole('button', { name: 'Ask to fix' }).click();
    await page.waitForFunction(() => window.sent.some((m) => m.method === 'ui/message'));

    const sent = await page.evaluate(() => window.sent);
    const call = sent.find((m) => m.method === 'tools/call');
    assert.deepEqual(call.params, { name: 'get-failure', arguments: { index: 1 } });
    const ask = sent.find((m) => m.method === 'ui/message');
    assert.equal(ask.params.role, 'user');
    assert.match(ask.params.content[0].text, /tests\/cart\.spec\.ts:42/);
    assert.ok(sent.some((m) => m.method === 'ui/notifications/size-changed'), 'reports its size');
  } finally {
    await page.close();
  }
});

test.after(async () => {
  await browser?.close();
});
