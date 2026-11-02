/**
 * Smoke test for the package as users install it: production dependencies
 * only, driven from a project with no Node Playwright (a pytest project).
 * The page tools must still open a browser through the server's own
 * playwright-core. CI runs this against `npm pack` installed with
 * --omit=dev, which a repo checkout (with devDependencies) cannot catch.
 *
 *   node scripts/installed-smoke.mjs <path to installed dist/index.js>
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/installed-smoke.mjs <installed dist/index.js>');
  process.exit(2);
}

const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-mcp-pytest-')));
writeFileSync(path.join(project, 'pytest.ini'), '[pytest]\n');

const page = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<title>Smoke</title><button>Buy now</button>');
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));

const env = { ...process.env, LOG_LEVEL: 'error', PW_MCP_PROJECT_ROOT: project };
delete env.NODE_PATH; // nothing but the install itself may supply Playwright
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: project, env });
const client = new Client({ name: 'installed-smoke', version: '1' });
let failed = false;
try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'inspect-page',
    arguments: { url: `http://127.0.0.1:${page.address().port}/` },
  });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError || !text.includes("getByRole('button', { name: 'Buy now' })")) {
    failed = true;
    console.error('inspect-page did not work from the installed package:\n' + text);
  } else {
    console.log('inspect-page works from the installed package (pytest project, no Node Playwright).');
  }
} finally {
  await client.close().catch(() => {});
  page.close();
}
process.exit(failed ? 1 : 0);
