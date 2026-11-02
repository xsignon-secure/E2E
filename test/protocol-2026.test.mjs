/**
 * The 2026-07-28 MCP revision and its extensions, end to end with the
 * official client SDK:
 *
 * - a client that negotiates the stateless revision (pinned or `auto`) gets
 *   it, over stdio-style transports and over the HTTP bridge, and a 2025
 *   client still gets the initialize handshake;
 * - list results carry cache hints (SEP-2549);
 * - serverInfo carries the title, description, website and icon, matching
 *   the MCP Registry entry (server.json);
 * - the bundled skill is served over the Skills extension (SEP-2640) and
 *   every file verifies against its digest;
 * - the HTTP bridge publishes a Server Card and an AI Catalog (SEP-2127)
 *   without authentication and with open CORS;
 * - a `traceparent` in the request `_meta` (SEP-414) is parsed for logs.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, supportedProtocolVersions, traceContext, MODERN_PROTOCOL_VERSION } from '../dist/server.js';
import { createMcpHttpHandler, handleNodeRequest, discoveryResponse } from '../dist/http.js';
import { CACHE_HINTS, SERVER_IDENTITY, REGISTRY_NAME } from '../dist/discovery.js';

const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function connectInMemory(mode) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer({ projectRoot: process.cwd() }), { transport: serverSide });
  const client = new Client({ name: 'protocol-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

test('offers the 2026-07-28 revision first, then the 2025 versions', () => {
  const versions = supportedProtocolVersions();
  assert.equal(versions[0], MODERN_PROTOCOL_VERSION);
  assert.ok(versions.includes('2025-11-25'));
  assert.ok(versions.includes('2025-06-18'));
});

test('PW_MCP_PROTOCOL=legacy drops the 2026 revision', () => {
  process.env.PW_MCP_PROTOCOL = 'legacy';
  try {
    assert.ok(!supportedProtocolVersions().includes(MODERN_PROTOCOL_VERSION));
  } finally {
    delete process.env.PW_MCP_PROTOCOL;
  }
});

for (const mode of [{ pin: MODERN_PROTOCOL_VERSION }, 'auto']) {
  test(`a 2026-07-28 client (${JSON.stringify(mode)}) gets the stateless revision with cache hints`, async () => {
    const { client, close } = await connectInMemory(mode);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), MODERN_PROTOCOL_VERSION);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 20);
      assert.equal(tools.ttlMs, CACHE_HINTS['tools/list'].ttlMs);
      assert.equal(tools.cacheScope, 'private');
      const prompts = await client.listPrompts();
      assert.equal(prompts.ttlMs, CACHE_HINTS['prompts/list'].ttlMs);
      const result = await client.callTool({ name: 'get-run-status', arguments: { runId: 'nope' } });
      assert.equal(result.isError, true, 'a tool call works and reports its own error');
    } finally {
      await close();
    }
  });
}

test('a 2025 client still gets the initialize handshake', async () => {
  const { client, close } = await connectInMemory('legacy');
  try {
    assert.notEqual(client.getNegotiatedProtocolVersion(), MODERN_PROTOCOL_VERSION);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 20);
    assert.equal(tools.ttlMs, undefined, '2025 responses are never given cache fields');
  } finally {
    await close();
  }
});

test('the real stdio binary serves both eras on one connection each', async () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  for (const [mode, modern] of [['auto', true], ['legacy', false]]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'ignore' });
    const client = new Client({ name: 'protocol-stdio-test', version: '1.0.0' }, { versionNegotiation: { mode } });
    await client.connect(transport);
    try {
      assert.equal(client.getNegotiatedProtocolVersion() === MODERN_PROTOCOL_VERSION, modern, mode);
      assert.equal((await client.listTools()).tools.length, 20);
    } finally {
      await client.close();
    }
  }
});

test('serverInfo carries the identity the MCP Registry lists', async () => {
  const { client, close } = await connectInMemory({ pin: MODERN_PROTOCOL_VERSION });
  try {
    const info = client.getServerVersion();
    assert.equal(info.name, 'playwright-e2e-mcp');
    assert.equal(info.version, pkg.version);
    assert.equal(info.title, serverJson.title);
    assert.equal(info.description, serverJson.description);
    assert.equal(info.websiteUrl, serverJson.websiteUrl);
    assert.deepEqual(info.icons, serverJson.icons);
    assert.ok(info.description.length <= 100, 'Server Card and registry limit');
    assert.equal(REGISTRY_NAME, pkg.mcpName);
    assert.equal(REGISTRY_NAME, serverJson.name);
  } finally {
    await close();
  }
});

for (const mode of [{ pin: MODERN_PROTOCOL_VERSION }, 'legacy']) {
  test(`the bundled skill is served over the Skills extension (${JSON.stringify(mode)})`, async () => {
    const { client, close } = await connectInMemory(mode);
    try {
      const skills = new SkillsClient(client);
      assert.equal(skills.supported, true);
      const listing = await skills.list();
      assert.equal(listing.skills.length, 1);
      const [skill] = listing.skills;
      assert.equal(skill.uri, 'skill://playwright-e2e-mcp/SKILL.md');
      assert.equal(skill.frontmatter.name, 'playwright-e2e-mcp');
      const manifest = await skills.read(skill);
      assert.equal(manifest.verified, true);
      assert.match(manifest.body ?? manifest.text ?? '', /playwright-e2e-mcp/);
      for (const entry of skill.resources) {
        const ref = entry.uri.slice('skill://playwright-e2e-mcp/'.length);
        const file = await skills.read(skill, ref);
        assert.equal(file.verified, true, `${ref} verifies against its digest`);
      }
    } finally {
      await close();
    }
  });
}

test('PW_MCP_SKILLS=0 is documented as the off switch', () => {
  const source = readFileSync(new URL('../src/skills.ts', import.meta.url), 'utf8');
  assert.match(source, /PW_MCP_SKILLS === '0'/);
});

test('traceparent in _meta becomes trace ids for the logs', () => {
  assert.deepEqual(traceContext({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }), {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentSpanId: '00f067aa0ba902b7',
  });
  assert.deepEqual(traceContext({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }), {});
  assert.deepEqual(traceContext({ traceparent: 'garbage' }), {});
  assert.deepEqual(traceContext({ traceparent: 42 }), {});
  assert.deepEqual(traceContext(undefined), {});
});

// ---------------------------------------------------------------- HTTP bridge

const TOKEN = 'protocol-test-token-0123456789';
const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [] });
const srv = http.createServer((req, res) => void handleNodeRequest(handler, req, res));
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${srv.address().port}`;

after(async () => {
  await handler.close().catch(() => undefined);
  await new Promise((resolve) => srv.close(resolve));
});

test('the Server Card is public, CORS-open and matches the registry entry', async () => {
  const res = await fetch(`${base}/mcp/server-card`, { headers: { accept: 'application/mcp-server-card+json' } });
  assert.equal(res.status, 200, 'no token needed for public discovery metadata');
  assert.equal(res.headers.get('content-type'), 'application/mcp-server-card+json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const card = await res.json();
  assert.equal(card.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
  assert.equal(card.name, serverJson.name);
  assert.equal(card.version, pkg.version);
  assert.equal(card.description, serverJson.description);
  assert.equal(card.title, SERVER_IDENTITY.title);
  assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(card.remotes.length, 1);
  assert.equal(card.remotes[0].type, 'streamable-http');
  assert.equal(card.remotes[0].url, `${base}/mcp`);
  assert.ok(card.remotes[0].supportedProtocolVersions.includes(MODERN_PROTOCOL_VERSION));
  assert.equal(card.remotes[0].headers[0].name, 'Authorization');
  assert.equal(card.remotes[0].headers[0].isSecret, true);
  assert.ok(!JSON.stringify(card).includes(TOKEN), 'the card never carries the token');
  assert.equal(card.tools, undefined, 'cards do not list primitives');
});

test('the AI Catalog points at the card, and preflight is answered', async () => {
  const res = await fetch(`${base}/.well-known/ai-catalog.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/ai-catalog+json');
  const catalog = await res.json();
  assert.equal(catalog.specVersion, '1.0');
  assert.equal(catalog.entries[0].type, 'application/mcp-server-card+json');
  assert.equal(catalog.entries[0].url, `${base}/api/mcp/server-card`);
  assert.match(catalog.entries[0].identifier, /^urn:air:127\.0\.0\.1:mcp:/);

  const preflight = await fetch(`${base}/mcp/server-card`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  const post = await fetch(`${base}/mcp/server-card`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
});

test('the Vercel rewrite form (mcp_route) resolves to the configured endpoint', () => {
  const card = discoveryResponse(new Request('https://demo.example/api/mcp?mcp_route=server-card'), '/api/mcp', false);
  assert.ok(card);
  const catalog = discoveryResponse(new Request('https://demo.example/api/mcp?mcp_route=ai-catalog'), '/api/mcp', false);
  assert.ok(catalog);
  assert.equal(discoveryResponse(new Request('https://demo.example/api/mcp'), '/api/mcp', false), undefined);
});

test('an open endpoint advertises no Authorization header', async () => {
  const res = discoveryResponse(new Request('https://demo.example/api/mcp/server-card'), '/api/mcp', false);
  const card = await res.json();
  assert.equal(card.remotes[0].url, 'https://demo.example/api/mcp');
  assert.equal(card.remotes[0].headers, undefined);
});

test('a 2026-07-28 client negotiates the stateless revision over the HTTP bridge', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'protocol-http-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN_PROTOCOL_VERSION);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 20);
    assert.equal(tools.ttlMs, CACHE_HINTS['tools/list'].ttlMs);
    const skills = await new SkillsClient(client).list();
    assert.equal(skills.skills.length, 1);
  } finally {
    await client.close();
  }
});
