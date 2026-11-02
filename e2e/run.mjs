#!/usr/bin/env node
/**
 * Integration suite for playwright-e2e-mcp (run via `npm run e2e`).
 *
 * Unit tests (test/*.test.mjs) prove the pure logic; this suite proves the
 * *live* loop the server exists for. It:
 *
 *   1. starts a small fixture web app on an ephemeral port,
 *   2. boots the real MCP server (dist/index.js) over stdio with
 *      PW_MCP_PROJECT_ROOT pointing at e2e/fixture,
 *   3. drives it through the MCP protocol exactly like a client would, and
 *   4. asserts ~90 behaviours that only appear end-to-end:
 *      handshake + tool annotations + prompts, live DOM inspection with
 *      verified role locators, selector/locator validation, pages behind a
 *      login (storageState) and after steps (actions), visual baseline/diff
 *      (blue → red), pass/fail/lastFailed Playwright runs with progress
 *      notifications, background runs, trace network-404 + console-error
 *      diagnostics, suggest-fix (refusal on a missing element, verified heal
 *      of a renamed one), auto-retry flaky reporting, diagnose-flaky
 *      verdicts, run history ranking, scaffold generation and error paths.
 *
 * Exit code 0 only when every check passes.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtureRoot = path.join(here, 'fixture');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

// Secrets for the save-login checks: they reach the server only through its
// environment, never through tool arguments.
const LOGIN_PASSWORD = 'e2e-correct-horse';
const LOGIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const COLORS = { blue: 'rgb(37, 99, 235)', red: 'rgb(220, 38, 38)' };
const EXPECTED_TOOLS = [
  'analyze-history',
  'audit-accessibility',
  'audit-performance',
  'audit-tests',
  'bisect-failure',
  'check-mocks',
  'check-test-change',
  'compare-visual-state',
  'diagnose-flaky',
  'generate-e2e-test',
  'get-failure',
  'get-run-status',
  'inspect-page',
  'list-tests',
  'load-report',
  'quarantine',
  'run-test',
  'save-login',
  'suggest-fix',
  'validate-selector',
];

/* ------------------------------------------------------------------ */
/* Check bookkeeping                                                   */
/* ------------------------------------------------------------------ */

const checks = [];

function check(name, ok, detail) {
  const passed = Boolean(ok);
  checks.push({ name, ok: passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && detail ? `\n      ${detail}` : ''}\n`);
}

function contains(name, text, needle) {
  const ok = typeof text === 'string' && text.includes(needle);
  check(name, ok, ok ? undefined : `expected output to include ${JSON.stringify(needle)}${typeof text === 'string' ? '' : ` (got ${typeof text})`}`);
}

/* ------------------------------------------------------------------ */
/* Fixture web app                                                     */
/* ------------------------------------------------------------------ */

function pageHtml(flipped) {
  const initial = flipped ? COLORS.red : COLORS.blue;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Freebuff Demo Shop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 48px; background: #f8fafc; color: #0f172a; }
  #cta { padding: 20px 40px; font-size: 20px; color: #fff; border: 0; border-radius: 10px; cursor: pointer; }
</style>
</head>
<body>
  <h1>Freebuff Demo Shop</h1>
  <p>Fixture app for the playwright-e2e-mcp integration suite.</p>
  <button id="cta" data-testid="cta-button" style="background-color: ${initial}">Buy now</button>
  <script>
    (function () {
      var btn = document.getElementById('cta');
      var colors = ['${COLORS.blue}', '${COLORS.red}'];
      btn.addEventListener('click', function () {
        var next = btn.style.backgroundColor === '${COLORS.blue}' ? 1 : 0;
        btn.style.backgroundColor = colors[next];
      });
    })();
  </script>
</body>
</html>
`;
}

function accountHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Your account</title></head>
<body>
  <h1>Your account</h1>
  <button id="open-settings">Open settings</button>
  <dialog id="settings"><h2>Settings</h2><label for="nick">Nickname</label><input id="nick"><button>Save settings</button></dialog>
  <script>
    document.getElementById('open-settings').addEventListener('click', function () {
      document.getElementById('settings').showModal();
    });
  </script>
</body>
</html>
`;
}

async function startFixtureServer() {
  const { generateTotp, parseTotpSecret } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'utils', 'totp.js')).href);
  const totp = parseTotpSecret(LOGIN_TOTP_SECRET);
  // The previous window's code is accepted too, as real servers do.
  const totpOk = (code) => code === generateTotp(totp) || code === generateTotp(totp, Date.now() - 30_000);
  return new Promise((resolve, reject) => {
    const state = { flipped: false };
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/flip') {
        state.flipped = !state.flipped;
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/account') {
        if (!/(^|;\s*)session=ok(;|$)/.test(req.headers.cookie ?? '')) {
          res.writeHead(302, { location: '/login' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(accountHtml());
        return;
      }
      if (req.method === 'GET' && req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title><h1>Sign in</h1><label for="email">Email</label><input id="email"><button>Sign in</button>');
        return;
      }
      // A login with a password and an authenticator code, for save-login.
      if (req.method === 'GET' && req.url === '/signin') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><h1>Sign in</h1>' +
            '<form method="post" action="/signin"><label for="u">Email</label><input id="u" name="email"><label for="p">Password</label><input id="p" name="password" type="password">' +
            '<label for="otp">One-time code</label><input id="otp" name="otp" inputmode="numeric"><button>Sign in</button></form></body></html>',
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/signin') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const ok = form.get('email') === 'qa@example.com' && form.get('password') === LOGIN_PASSWORD && totpOk(form.get('otp') ?? '');
          if (!ok) {
            res.writeHead(302, { location: '/signin?error=1' }).end();
            return;
          }
          res.writeHead(302, { location: '/me', 'set-cookie': 'member=yes; Path=/; HttpOnly; Max-Age=3600' }).end();
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/me') {
        if (!/(^|;\s*)member=yes(;|$)/.test(req.headers.cookie ?? '')) {
          res.writeHead(302, { location: '/signin' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Me</title></head><body><h1>Welcome back</h1><button>Sign out</button></body></html>');
        return;
      }
      if (req.method === 'GET' && req.url === '/api/cart') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: ['Real item'] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/cart') {
        // Renders whatever /api/cart returns (items, an empty state or an
        // error), after a long task and a late banner that shifts the list.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cart</title></head><body><main><h1>Cart</h1><div id="slot"></div><ul id="cart"><li>Loading</li></ul><section style="height:300px">Recommended for you</section></main><script>' +
            "setTimeout(()=>{const p=document.createElement('p');p.style.height='240px';p.textContent='Late promo';document.getElementById('slot').appendChild(p);},600);" +
            "setTimeout(()=>{const t=Date.now();while(Date.now()-t<300){}},700);" +
            "fetch('/api/cart').then(r=>{if(!r.ok)throw new Error(r.status);return r.json()}).then(d=>{document.getElementById('cart').innerHTML=d.items.length?d.items.map(i=>'<li>'+i+'</li>').join(''):'<li>Your cart is empty</li>'}).catch(()=>{document.getElementById('cart').innerHTML='<li role=\"alert\">Could not load cart</li>'});" +
            '</script></body></html>',
        );
        return;
      }
      // Pages for the failure paths: a late button, a covered button, an
      // iframe, a redirect loop and a server error.
      const html = (body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body>${body}</body></html>`);
      };
      if (req.method === 'GET' && req.url === '/ssr') {
        // A server-rendered page in the style of Next.js: the button is in
        // the HTML, its handler arrives with a slow script 1.2 s later.
        html('<div id="__next"><button id="buy">Add to cart</button><p id="added"></p></div><script>self.__next_f=[]</script><script src="/ssr.js" async></script>');
        return;
      }
      if (req.method === 'GET' && req.url === '/ssr.js') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end("document.getElementById('buy').addEventListener('click',()=>{document.getElementById('added').textContent='Added'});document.getElementById('__next')['__reactContainer$e2e']={};");
        }, 1200);
        return;
      }
      if (req.method === 'GET' && req.url === '/late') {
        html("<h1>Late</h1><script>setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='Ready';document.body.append(b)},1500)</script>");
        return;
      }
      if (req.method === 'GET' && req.url === '/covered') {
        html('<button id="under">Buy</button><div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>');
        return;
      }
      if (req.method === 'GET' && req.url === '/frame') {
        html('<h1>Checkout</h1><iframe id="pay" title="Payment" src="/frame-inner" width="400" height="200"></iframe>');
        return;
      }
      if (req.method === 'GET' && req.url === '/frame-inner') {
        html('<label for="card">Card number</label><input id="card"><button>Pay</button>');
        return;
      }
      if (req.method === 'GET' && req.url === '/opener') {
        html('<h1>Shop</h1><button id="sso" onclick="window.open(\'/popup\', \'_blank\')">Sign in with SSO</button>');
        return;
      }
      if (req.method === 'GET' && req.url === '/popup') {
        html('<title>SSO provider</title><h1>Choose an account</h1><button>Continue as QA</button>');
        return;
      }
      if (req.method === 'GET' && req.url === '/order') {
        // Clicking "Place order" sends a POST the blockWrites option must stop.
        html('<h1>Order</h1><button id="place" onclick="fetch(\'/api/order\', { method: \'POST\' }).then(() => { document.body.insertAdjacentHTML(\'beforeend\', \'<p>sent</p>\'); }).catch(() => { document.body.insertAdjacentHTML(\'beforeend\', \'<p>blocked</p>\'); })">Place order</button>');
        return;
      }
      if (req.method === 'POST' && req.url === '/api/order') {
        state.orders = (state.orders ?? 0) + 1;
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'GET' && req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/oops') {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Error</title><h1>Something went wrong</h1>');
        return;
      }
      if (req.method === 'GET' && req.url === '/a11y') {
        // Known violations: an image without alt text, an unlabeled input
        // and a button with no accessible name.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signup</title></head><body><main><h1>Signup</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><form><input type="email"><button type="submit" data-testid="go"><svg width="10" height="10"></svg></button></form></main></body></html>');
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml(state.flipped));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: req.url }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        state,
        flip: async () => {
          const response = await fetch(`http://127.0.0.1:${port}/flip`, { method: 'POST' });
          if (!response.ok) throw new Error(`fixture flip failed: ${response.status}`);
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Minimal MCP stdio client (newline-delimited JSON-RPC 2.0)           */
/* ------------------------------------------------------------------ */

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = null;
    this.notifications = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Non-protocol noise on stdout is a bug we surface elsewhere.
        }
        if (message.id === undefined && typeof message.method === 'string') {
          this.notifications.push(message);
          continue;
        }
        if (message.id === undefined || !this.pending.has(message.id)) continue;
        const entry = this.pending.get(message.id);
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? 'JSON-RPC error');
          error.code = message.error.code;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-40_000);
    });

    child.on('close', (code, signal) => {
      this.exited = { code, signal };
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server exited unexpectedly (code ${code}, signal ${signal})`));
      }
      this.pending.clear();
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP server already exited (code ${this.exited.code})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** End stdin (the server's graceful-shutdown signal) and await exit. */
  async stop() {
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        /* already closed */
      }
      await new Promise((done) => {
        const timer = setTimeout(done, 15_000);
        this.child.once('close', () => {
          clearTimeout(timer);
          done();
        });
      });
      if (!this.exited) this.child.kill();
    }
    return this.exited;
  }
}

async function callTool(client, name, args, timeoutMs = 150_000, meta) {
  const result = await client.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs);
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return { result, text, isError: result.isError === true };
}

/* ------------------------------------------------------------------ */
/* Fixture lifecycle                                                   */
/* ------------------------------------------------------------------ */

function cleanFixture() {
  const stale = ['test-results', 'playwright-report', 'blob-report', '.pw-mcp', '.playwright-e2e-mcp', '.auth', 'tests/generated', 'tests/.flaky-marker', 'tests/heal.spec.ts', 'tests/slot.spec.ts', 'tests/order.spec.ts', 'tests/.slot-lock', 'playwright', 'playwright-quarantine.json'];
  for (const entry of stale) {
    rmSync(path.join(fixtureRoot, entry), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function phaseHandshake(client, pkg) {
  const init = await client.request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'playwright-e2e-mcp-e2e', version: '1.0.0' },
    },
    30_000,
  );
  check('initialize handshake returns our server', init?.serverInfo?.name === 'playwright-e2e-mcp', `got ${JSON.stringify(init?.serverInfo)}`);
  check('server reports the package version', init?.serverInfo?.version === pkg.version, `expected ${pkg.version}, got ${init?.serverInfo?.version}`);
  client.notify('notifications/initialized');

  const list = await client.request('tools/list', {}, 30_000);
  const tools = list.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  check(`tools/list exposes all ${EXPECTED_TOOLS.length} tools`, JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `got ${JSON.stringify(names)}`);

  const prompts = await client.request('prompts/list', {}, 30_000);
  const promptNames = (prompts.prompts ?? []).map((prompt) => prompt.name).sort();
  check('prompts/list offers the fix and triage workflows', JSON.stringify(promptNames) === JSON.stringify(['fix-failing-test', 'triage-flaky-tests']), `got ${JSON.stringify(promptNames)}`);
  const fixPrompt = await client.request('prompts/get', { name: 'fix-failing-test', arguments: { test: 'tests/fail.spec.ts' } }, 30_000);
  contains('fix-failing-test prompt walks the suggest-fix loop', fixPrompt.messages?.[0]?.content?.text, 'suggest-fix');

  const missingAnnotations = tools.filter((tool) => typeof tool?.annotations?.readOnlyHint !== 'boolean');
  check('every tool declares spec tool annotations', missingAnnotations.length === 0, `missing readOnlyHint on: ${missingAnnotations.map((t) => t.name).join(', ')}`);

  const missingSchema = tools.filter((tool) => tool?.inputSchema?.type !== 'object' && !tool?.inputSchema?.properties);
  check('every tool input schema is an object schema', missingSchema.length === 0, `bad schema on: ${missingSchema.map((t) => t.name).join(', ')}`);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  check(
    'safety hints: run-test mutates, get-failure is read-only',
    byName.get('run-test')?.annotations?.readOnlyHint === false && byName.get('get-failure')?.annotations?.readOnlyHint === true,
    JSON.stringify({ runTest: byName.get('run-test')?.annotations, getFailure: byName.get('get-failure')?.annotations }),
  );
  const missingTitles = tools.filter((tool) => typeof tool.title !== 'string' || tool.title === '');
  check('every tool has a title', missingTitles.length === 0, `untitled: ${missingTitles.map((t) => t.name).join(', ')}`);
  const withSchema = tools.filter((tool) => tool.outputSchema?.type === 'object').map((tool) => tool.name).sort();
  check(
    'the chained tools declare output schemas',
    JSON.stringify(withSchema) === JSON.stringify(['audit-accessibility', 'audit-performance', 'audit-tests', 'bisect-failure', 'check-test-change', 'diagnose-flaky', 'get-failure', 'get-run-status', 'list-tests', 'quarantine', 'run-test', 'save-login', 'suggest-fix', 'validate-selector']),
    `got ${JSON.stringify(withSchema)}`,
  );
}

async function phaseLivePage(client, origin) {
  const inspect = await callTool(
    client,
    'inspect-page',
    { url: origin, waitFor: '#cta', view: 'elements' },
    90_000,
  );
  check('inspect-page returns the live DOM', !inspect.isError && inspect.text.includes('Freebuff Demo Shop'), inspect.text.slice(0, 400));
  contains('inspect-page sees data-testid="cta-button"', inspect.text, 'cta-button');
  contains('inspect-page sees the button text', inspect.text, 'Buy now');

  const valid = await callTool(client, 'validate-selector', { url: origin, selector: '#cta' }, 90_000);
  check('validate-selector: #cta matches once', !valid.isError && valid.text.includes('## ✅ VALID — 1 match'), valid.text.slice(0, 300));

  const missing = await callTool(client, 'validate-selector', { url: origin, selector: '#not-here' }, 90_000);
  contains('validate-selector: missing id reports 0 matches', missing.text, 'VALID — 0 matches');

  const engine = await callTool(client, 'validate-selector', { url: origin, selector: 'text=Buy now' }, 90_000);
  contains('validate-selector: Playwright selector engines are validated', engine.text, '## ✅ VALID — 1 match');
  contains('validate-selector: suggests the role locator for the match', engine.text, "unique locator: `getByRole('button', { name: 'Buy now' })`");

  const role = await callTool(client, 'validate-selector', { url: origin, selector: "page.getByRole('button', { name: 'Buy now' })" }, 90_000);
  contains('validate-selector: getByRole locator matches once', role.text, '## ✅ VALID — 1 match');
  contains('validate-selector: shows the parsed locator', role.text, "**Parsed as:** `getByRole('button', { name: 'Buy now' })`");

  const unsafe = await callTool(client, 'validate-selector', { url: origin, selector: "getByRole('button').evaluate(() => 1)" }, 30_000);
  contains('validate-selector: refuses non-locator code', unsafe.text, '## ❌ INVALID');

  const map = await callTool(client, 'inspect-page', { url: origin, view: 'locators' }, 90_000);
  contains('inspect-page locator map lists the verified role locator', map.text, "`getByRole('button', { name: 'Buy now' })` — button \"Buy now\"");
  contains('inspect-page locator map offers the test id alternative', map.text, "getByTestId('cta-button')");
  contains('inspect-page DOM view carries locators too', inspect.text, "locator: `getByRole('button', { name: 'Buy now' })`");

  const phone = await callTool(client, 'inspect-page', { url: origin, device: 'Pixel 7' }, 90_000);
  contains('inspect-page with a device preset uses its viewport', phone.text, '412×839');
  const badDevice = await callTool(client, 'inspect-page', { url: origin, device: 'Pixel 99' }, 90_000);
  check('inspect-page names close matches for an unknown device', badDevice.isError && badDevice.text.includes('Close matches: Pixel'), badDevice.text.slice(0, 300));

  const ssr = await callTool(client, 'inspect-page', { url: `${origin}/ssr` }, 90_000);
  contains('inspect-page names the framework of a server-rendered page', ssr.text, '**Hydration:** ⚡ Next.js, server-rendered');
  check('inspect-page measures the hydration gap', /controls were on screen \*\*(\d+) ms\*\*/.test(ssr.text) && Number(/\*\*(\d+) ms\*\*/.exec(ssr.text)[1]) >= 800, ssr.text.slice(0, 600));
  contains('inspect-page says how a test waits for hydration', ssr.text, "html[data-hydrated]");
  const csr = await callTool(client, 'inspect-page', { url: origin }, 90_000);
  check('inspect-page adds no hydration line to a plain page', !csr.text.includes('**Hydration:**'), csr.text.slice(0, 300));

  const loggedOut = await callTool(client, 'inspect-page', { url: `${origin}/account` }, 90_000);
  contains('inspect-page without a session lands on the login page', loggedOut.text, '"Sign in"');
  contains('inspect-page hints at storageState on a login page', loggedOut.text, 'Pass `storageState`');

  const host = new URL(origin).hostname;
  mkdirSync(path.join(fixtureRoot, '.auth'), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, '.auth', 'user.json'),
    JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }),
  );
  const loggedIn = await callTool(
    client,
    'inspect-page',
    {
      url: `${origin}/account`,
      storageState: '.auth/user.json',
      view: 'locators',
      actions: [{ type: 'click', locator: "getByRole('button', { name: 'Open settings' })" }],
    },
    90_000,
  );
  contains('storageState opens the page behind the login', loggedIn.text, '"Your account"');
  contains('page state line names the session file', loggedIn.text, 'session `.auth/user.json`');
  contains('actions reach the settings dialog', loggedIn.text, "getByRole('heading', { name: 'Settings' })");
  contains('locators inside the dialog are verified', loggedIn.text, "getByRole('textbox', { name: 'Nickname' })");

  const audit = await callTool(client, 'audit-accessibility', { url: `${origin}/a11y` }, 90_000);
  check('audit-accessibility reports violations', !audit.isError && /## ♿ \d+ accessibility violations/.test(audit.text), audit.text.slice(0, 600));
  contains('audit flags the image without alt text', audit.text, '`image-alt`');
  contains('audit flags the unlabeled input', audit.text, '`label`');
  contains('audit names the button by a verified locator', audit.text, "getByTestId('go')");
  contains('audit cites the WCAG criterion', audit.text, 'WCAG 1.1.1');
  contains('audit hands back a regression check', audit.text, 'new AxeBuilder({ page })');

  const cleanAudit = await callTool(
    client,
    'audit-accessibility',
    { url: `${origin}/account`, storageState: '.auth/user.json', actions: [{ type: 'click', locator: "getByRole('button', { name: 'Open settings' })" }] },
    90_000,
  );
  check('audit runs behind the login and after actions', !cleanAudit.isError && cleanAudit.text.includes('session `.auth/user.json`'), cleanAudit.text.slice(0, 600));

  const perf = await callTool(client, 'audit-performance', { url: `${origin}/cart`, runs: 2 }, 120_000);
  check('audit-performance reports Web Vitals', !perf.isError && perf.text.includes('| LCP · largest contentful paint |'), perf.text.slice(0, 600));
  contains('audit-performance reports the median of runs', perf.text, '**Runs:** 2 (median)');
  contains('audit-performance flags the late layout shift', perf.text, '**CLS ');
  contains('audit-performance flags the long task', perf.text, '**TBT ');
  contains('audit-performance lists requests', perf.text, '/api/cart');
  contains('audit-performance hands back a budget check', perf.text, "test('stays within the performance budget'");
  const budget = await callTool(client, 'audit-performance', { url: `${origin}/cart`, throttle: 'mobile', budgets: { cls: 0.01, requests: 50 } }, 120_000);
  contains('audit-performance checks budgets', budget.text, 'performance budget exceeded (CLS)');
  contains('audit-performance emulates a phone', budget.text, 'mobile, slow 4G, 4x CPU slowdown');

  const failedApi = await callTool(
    client,
    'inspect-page',
    { url: `${origin}/cart`, selector: '#cart li[role="alert"]', waitFor: '#cart li[role="alert"]', routes: [{ url: '**/api/cart', status: 500, body: 'boom' }, { url: '**/api/never', json: {} }] },
    60_000,
  );
  contains('a mocked 500 renders the error state', failedApi.text, 'Could not load cart');
  contains('mock hits are reported', failedApi.text, '`**/api/cart → 500`: matched 1 request');
  contains('an unmatched mock is flagged', failedApi.text, '⚠️ `**/api/never → 200 JSON`: matched **no** request');
  const emptyCart = await callTool(
    client,
    'validate-selector',
    { url: `${origin}/cart`, selector: "getByText('Your cart is empty')", actions: [{ type: 'wait', locator: "getByText('Your cart is empty')" }], routes: [{ url: '**/api/cart', json: { items: [] } }] },
    60_000,
  );
  contains('a mocked JSON body renders the empty state', emptyCart.text, '1 match');

  const aria = await callTool(client, 'inspect-page', { url: `${origin}/cart`, view: 'aria', selector: '#cart', waitFor: "#cart li:not(:has-text('Loading'))" }, 60_000);
  contains('aria view returns the snapshot', aria.text, '- listitem: Real item');
  contains('aria view hands back an assertion', aria.text, `await expect(page.locator("#cart")).toMatchAriaSnapshot(\``);

  const harPath = path.join(fixtureRoot, 'test-results', 'cart.har');
  mkdirSync(path.dirname(harPath), { recursive: true });
  const recorded = await callTool(client, 'inspect-page', { url: `${origin}/cart`, view: 'aria', selector: '#cart', waitFor: "text=Real item", har: { path: 'test-results/cart.har', mode: 'record', url: '**/api/cart' } }, 60_000);
  contains('HAR recording is reported', recorded.text, 'recording HAR to `test-results/cart.har`');
  const har = existsSync(harPath) ? readFileSync(harPath, 'utf8') : '';
  check('HAR file written with the API response', har.includes('Real item'), har.slice(0, 300));
  writeFileSync(harPath, har.replace('Real item', 'Item from HAR'));
  const replayed = await callTool(client, 'inspect-page', { url: `${origin}/cart`, view: 'aria', selector: '#cart', waitFor: 'text=Item from HAR', har: { path: 'test-results/cart.har', url: '**/api/cart' } }, 60_000);
  contains('HAR replay answers the API from the file', replayed.text, '- listitem: Item from HAR');
  const webkitPerf = await callTool(client, 'audit-performance', { url: origin, browser: 'webkit' }, 30_000);
  check('audit-performance refuses other engines', webkitPerf.isError && webkitPerf.text.includes('Chromium only'), webkitPerf.text.slice(0, 300));

  const escape = await callTool(client, 'inspect-page', { url: origin, storageState: '../../package.json' }, 30_000);
  check('storageState outside the project is refused', escape.isError && escape.text.includes('INVALID_PATH'), escape.text.slice(0, 300));

  const badStep = await callTool(
    client,
    'inspect-page',
    { url: origin, actions: [{ type: 'click', locator: "getByRole('button', { name: 'Does not exist' })" }], timeoutMs: 30_000 },
    60_000,
  );
  check('a failing action names the step', badStep.isError && badStep.text.includes('step 1 (click'), badStep.text.slice(0, 400));
  check('a failing action reports the page URL and the call log', badStep.text.includes('Page URL at failure:') && badStep.text.includes('Call log:'), badStep.text.slice(0, 600));

  const covered = await callTool(client, 'inspect-page', { url: `${origin}/covered`, actions: [{ type: 'click', locator: '#under' }], actionTimeoutMs: 2_000 }, 60_000);
  check(
    'a click on a covered element says what covers it',
    covered.isError && covered.text.includes('intercepts pointer events') && covered.text.includes('overlay') && covered.text.includes('Timeout 2000ms'),
    covered.text.slice(0, 800),
  );

  const slowStep = await callTool(client, 'inspect-page', { url: `${origin}/late`, actions: [{ type: 'click', locator: '#late' }], actionTimeoutMs: 1_000 }, 60_000);
  check('actionTimeoutMs bounds each step', slowStep.isError && slowStep.result.structuredContent?.error?.kind === 'TIMEOUT' && slowStep.text.includes('Timeout 1000ms'), slowStep.text.slice(0, 400));

  const wholeCall = await callTool(client, 'inspect-page', { url: `${origin}/late`, actions: [{ type: 'wait', locator: '#never' }], actionTimeoutMs: 60_000, timeoutMs: 4_000 }, 60_000);
  check('running out of timeoutMs is a TIMEOUT, not a crash', wholeCall.result.structuredContent?.error?.kind === 'TIMEOUT' && wholeCall.text.includes('exceeded timeoutMs'), wholeCall.text.slice(0, 400));

  const late = await callTool(client, 'validate-selector', { url: `${origin}/late`, selector: '#late', waitFor: '#late' }, 60_000);
  check(
    'validate-selector waits for late elements and returns structured counts',
    late.result.structuredContent?.valid === true && late.result.structuredContent?.matches === 1 && late.result.structuredContent?.locator === "getByRole('button', { name: 'Ready' })",
    JSON.stringify(late.result.structuredContent),
  );

  const framed = await callTool(client, 'inspect-page', { url: `${origin}/frame`, actions: [{ type: 'fill', locator: "frameLocator('#pay').getByLabel('Card number')", value: '4242' }], view: 'locators' }, 60_000);
  check('actions reach into an iframe with frameLocator', !framed.isError && framed.text.includes('step 1 (fill frameLocator'), framed.text.slice(0, 400));
  const frameButton = await callTool(client, 'validate-selector', { url: `${origin}/frame`, selector: "locator('#pay').contentFrame().getByRole('button', { name: 'Pay' })" }, 60_000);
  check('validate-selector resolves locators inside an iframe', frameButton.result.structuredContent?.matches === 1, frameButton.text.slice(0, 400));

  // Popups: a click opens a new tab; switchTab moves inspection there.
  const popup = await callTool(client, 'inspect-page', { url: `${origin}/opener`, actions: [{ type: 'click', locator: "getByRole('button', { name: 'Sign in with SSO' })" }, { type: 'switchTab', value: 'popup' }], view: 'locators' }, 60_000);
  check('switchTab inspects the popup a click opened', !popup.isError && popup.text.includes('Continue as QA'), popup.text.slice(0, 600));
  contains('the result lists every open tab and marks the inspected one', popup.text, '**(inspected)**');
  const popupLast = await callTool(client, 'validate-selector', { url: `${origin}/opener`, selector: "getByRole('button', { name: 'Continue as QA' })", actions: [{ type: 'click', locator: '#sso' }, { type: 'switchTab' }] }, 60_000);
  check("switchTab defaults to the newest tab", popupLast.result.structuredContent?.matches === 1, popupLast.text.slice(0, 400));
  const noTab = await callTool(client, 'inspect-page', { url: `${origin}/opener`, actions: [{ type: 'switchTab', value: 'nowhere' }], actionTimeoutMs: 1_000 }, 60_000);
  check('switchTab names the open tabs when none matches', noTab.isError && noTab.text.includes('No tab matches "nowhere"'), noTab.text.slice(0, 400));

  // blockWrites: the POST is aborted before it reaches the server.
  fixtureState.orders = 0;
  const blocked = await callTool(client, 'inspect-page', { url: `${origin}/order`, blockWrites: true, actions: [{ type: 'click', locator: '#place' }, { type: 'wait', locator: "getByText('blocked')" }], view: 'locators' }, 60_000);
  check('blockWrites stops the POST before it reaches the server', !blocked.isError && fixtureState.orders === 0, `${blocked.text.slice(0, 400)} orders=${fixtureState.orders}`);
  contains('blockWrites lists the blocked request', blocked.text, 'POST');
  const mockedWrite = await callTool(client, 'inspect-page', { url: `${origin}/order`, blockWrites: true, routes: [{ url: '**/api/order', method: 'POST', status: 201, json: { ok: true } }], actions: [{ type: 'click', locator: '#place' }, { type: 'wait', locator: "getByText('sent')" }], view: 'locators' }, 60_000);
  check('a mock still answers a write under blockWrites', !mockedWrite.isError && fixtureState.orders === 0, mockedWrite.text.slice(0, 400));

  // save-login: password from the environment, a live authenticator code,
  // a checked session file, reuse while valid, and a failed login reported.
  const loginSteps = [
    { type: 'fill', locator: "getByLabel('Email')", value: 'qa@example.com' },
    { type: 'fill', locator: "getByLabel('Password')", value: '{{env:E2E_PASSWORD}}' },
    { type: 'fill', locator: "getByLabel('One-time code')", value: '{{totp}}' },
    { type: 'click', locator: "getByRole('button', { name: 'Sign in' })" },
  ];
  const loginVerify = { url: '/me', visible: "getByRole('button', { name: 'Sign out' })", notUrl: '/signin' };
  const saved = await callTool(client, 'save-login', { url: `${origin}/signin`, actions: loginSteps, verify: loginVerify, totpSecretEnv: 'E2E_TOTP_SECRET' }, 90_000);
  const authFile = path.join(fixtureRoot, 'playwright', '.auth', 'user.json');
  const authText = existsSync(authFile) ? readFileSync(authFile, 'utf8') : '';
  check(
    'save-login logs in with an env password and a TOTP code, and saves a checked session',
    saved.result.structuredContent?.status === 'saved' && saved.result.structuredContent?.valid === true && authText.includes('"member"'),
    saved.text.slice(0, 600),
  );
  check('save-login keeps the password out of its output and the session file', !saved.text.includes(LOGIN_PASSWORD) && !authText.includes(LOGIN_PASSWORD), saved.text.slice(0, 300));
  const reused = await callTool(client, 'save-login', { url: `${origin}/signin`, actions: loginSteps, verify: loginVerify, totpSecretEnv: 'E2E_TOTP_SECRET' }, 90_000);
  check('save-login reuses a session that still works', reused.result.structuredContent?.status === 'valid' && reused.text.includes('STILL VALID'), reused.text.slice(0, 400));
  const asMember = await callTool(client, 'inspect-page', { url: `${origin}/me`, storageState: 'playwright/.auth/user.json', view: 'locators' }, 60_000);
  check('the saved session opens the signed-in page', !asMember.isError && asMember.text.includes('Sign out'), asMember.text.slice(0, 400));
  const badLogin = await callTool(
    client,
    'save-login',
    { url: `${origin}/signin`, actions: loginSteps.map((s, i) => (i === 1 ? { ...s, value: 'wrong-password' } : s)), verify: loginVerify, totpSecretEnv: 'E2E_TOTP_SECRET', name: 'wrong', reuse: false },
    90_000,
  );
  check(
    'save-login reports a failed login and writes no file',
    badLogin.result.structuredContent?.valid === false && badLogin.text.includes('LOGIN FAILED') && !existsSync(path.join(fixtureRoot, 'playwright', '.auth', 'wrong.json')),
    badLogin.text.slice(0, 400),
  );
  const blockedEnv = await callTool(client, 'save-login', { url: `${origin}/signin`, actions: [{ type: 'fill', locator: "getByLabel('Email')", value: '{{env:HOME}}' }], name: 'leak' }, 60_000);
  check('save-login refuses environment variables outside the test-login allowlist', blockedEnv.isError && blockedEnv.text.includes('HOME'), blockedEnv.text.slice(0, 300));

  const loop = await callTool(client, 'inspect-page', { url: `${origin}/loop` }, 60_000);
  check('a redirect loop is a navigation failure, not a stopped server', loop.result.structuredContent?.error?.kind === 'NAVIGATION_FAILED' && loop.text.includes('redirects in a loop'), loop.text.slice(0, 400));

  const oops = await callTool(client, 'inspect-page', { url: `${origin}/oops`, view: 'locators' }, 60_000);
  check('an error status is reported', oops.text.includes('HTTP 500') && oops.result.structuredContent?.httpStatus === 500, oops.text.slice(0, 400));

  const broken = await callTool(client, 'validate-selector', { url: origin, selector: 'div >' }, 90_000);
  contains('validate-selector: CSS parse error reported', broken.text, '## ❌ INVALID');

  const baseline = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta', action: 'baseline' }, 90_000);
  contains('visual baseline created', baseline.text, '📸 Baseline');

  const same = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta' }, 90_000);
  contains('unchanged page matches its baseline', same.text, '✅ No visual change');

  await flipFixture();
  const changed = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta' }, 90_000);
  check(
    'changed button detected with blue → red color shift',
    !changed.isError && changed.text.includes('⚠️ Visual change detected') && changed.text.includes('blue → red') && changed.text.includes('Diff image'),
    changed.text.slice(0, 600),
  );
  await flipFixture(); // restore the blue starting state for the test runs

  // A port nothing listens on (browsers refuse well-known ports such as 9 outright).
  const closedPort = await new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
  const dead = await callTool(client, 'inspect-page', { url: `http://127.0.0.1:${closedPort}/` }, 60_000);
  check(
    'dead server detected (SERVER_NOT_RUNNING)',
    dead.isError && dead.text.includes('SERVER_NOT_RUNNING'),
    dead.text.slice(0, 300),
  );
}

// Set by main() so phaseLivePage can toggle the fixture app's button color.
let flipFixture = async () => {};
/** The fixture server's mutable state (orders counted by /api/order). */
let fixtureState = {};

async function phaseTestRuns(client, origin) {
  const list = await callTool(client, 'list-tests', {}, 90_000);
  contains('list-tests finds 3 fixture tests', list.text, '3 tests found');
  contains('list-tests uses `playwright test --list`', list.text, 'Playwright `--list`');
  contains('list-tests lists pass.spec.ts', list.text, 'tests/pass.spec.ts');
  contains('list-tests lists fail.spec.ts', list.text, 'tests/fail.spec.ts');
  contains('list-tests lists flaky.spec.ts', list.text, 'tests/flaky.spec.ts');

  const pass = await callTool(client, 'run-test', { testFiles: ['tests/pass.spec.ts'] }, 180_000);
  check('run-test passes the healthy spec', !pass.isError && pass.text.includes('✅ PASSED'), pass.text.slice(0, 500));
  contains('pass run reports stats | 1 | 0 | 0 | 0 |', pass.text, '| 1 | 0 | 0 | 0 |');

  // A Playwright process that dies hard (OOM killer, crash) never writes its
  // JSON report; the failure that finished before it died must still be
  // reported. The second test kills the runner process from its worker.
  const hangSpec = path.join(fixtureRoot, 'tests', 'zz-killed-run.spec.ts');
  writeFileSync(
    hangSpec,
    "import { expect, test } from '@playwright/test';\n\ntest('fails before the kill', async () => {\n  expect(1, 'killed-run marker').toBe(2);\n});\n\ntest('kills the runner', async () => {\n  process.kill(process.ppid, 'SIGKILL');\n  await new Promise(() => undefined);\n});\n",
  );
  try {
    const killed = await callTool(client, 'run-test', { testFiles: ['tests/zz-killed-run.spec.ts'], retryOnFailure: false, timeoutMs: 60_000 }, 120_000);
    check('a crashed run still reports the failure that finished', killed.text.includes('killed-run marker') && killed.text.includes('fails before the kill'), killed.text.slice(0, 800));
    contains('a crashed run says where the failures came from', killed.text, 'never wrote its JSON report');
    check('a crashed run is marked partial', killed.result.structuredContent?.run?.partial === true && killed.result.structuredContent.run.failures?.length === 1, JSON.stringify(killed.result.structuredContent?.run).slice(0, 300) + ` failures=${killed.result.structuredContent?.run?.failures?.length}`);
  } finally {
    rmSync(hangSpec, { force: true });
  }

  client.notifications.length = 0;
  const fail = await callTool(client, 'run-test', { testFiles: ['tests/fail.spec.ts'], retryOnFailure: false }, 180_000, { progressToken: 'e2e-fail' });
  const progress = client.notifications.filter((n) => n.method === 'notifications/progress' && n.params?.progressToken === 'e2e-fail');
  check('run-test sends progress notifications', progress.length > 0 && progress.some((n) => n.params.total === 1), JSON.stringify(progress.slice(-2)));
  check('run-test fails the broken spec', !fail.isError && fail.text.includes('❌ FAILED'), fail.text.slice(0, 500));
  contains('fail run names the missing save-btn', fail.text, 'save-btn');
  contains('fail run reports stats | 0 | 1 | 0 | 0 |', fail.text, '| 0 | 1 | 0 | 0 |');
  contains('fail run reports the project-relative file path', fail.text, '**File:** `tests/fail.spec.ts');
  const failData = fail.result.structuredContent;
  check(
    'run-test returns structured results',
    failData?.ok === false && failData.run?.failed === 1 && failData.run.failures?.[0]?.file === 'tests/fail.spec.ts' && typeof failData.run.failures[0].line === 'number',
    JSON.stringify(failData).slice(0, 400),
  );

  const failure = await callTool(client, 'get-failure', {}, 60_000);
  contains('get-failure reports Failure 1 of 1', failure.text, '## Failure 1 of 1');
  contains('get-failure titles the failure', failure.text, 'checkout save button surfaces cart errors');
  contains('get-failure points at the project-relative file', failure.text, '**File:** `tests/fail.spec.ts');
  contains('get-failure suggests a runnable re-run path', failure.text, 'testFiles: ["tests/fail.spec.ts:');
  check(
    'get-failure returns the failure as structured data',
    failure.result.structuredContent?.failure?.title?.includes('checkout save button') && failure.result.structuredContent.total === 1,
    JSON.stringify(failure.result.structuredContent).slice(0, 400),
  );
  contains('get-failure captured the DOM at failure (trace)', failure.text, '### DOM at failure (Playwright trace)');
  contains('get-failure lists the failed 404 request', failure.text, '### Network requests that failed');
  contains('get-failure shows the 404 URL', failure.text, 'missing.json');
  contains('get-failure surfaces the console error', failure.text, 'fixture-console-error: cart service unreachable');
  contains('get-failure shows the console section', failure.text, '### Console before the failure');
  contains('get-failure provides a diagnosis', failure.text, '### Diagnosis');
  contains('get-failure provides next steps', failure.text, '### Next steps');

  const refuse = await callTool(client, 'suggest-fix', {}, 90_000);
  contains('suggest-fix refuses to heal a missing element', refuse.text, "No confident replacement for `getByTestId('save-btn')`");
  contains('suggest-fix explains it is likely an app bug', refuse.text, 'most likely **missing**');

  const lastFailed = await callTool(client, 'run-test', { lastFailed: true }, 180_000);
  contains('lastFailed run is labelled (--last-failed)', lastFailed.text, 'failed tests only (--last-failed)');
  contains('lastFailed reran the failing test', lastFailed.text, '| 0 | 1 | 0 | 0 |');
  check(
    'lastFailed did NOT rerun the passing test',
    !lastFailed.text.includes('tests/pass.spec.ts'),
    'pass.spec.ts appeared in the --last-failed run output',
  );

  // No testFiles → the target comes from the stored failure's file path;
  // this proves the parser rebase (tests/fail.spec.ts, not fail.spec.ts)
  // flows into the default targeting and covers the third verdict.
  const consistent = await callTool(client, 'diagnose-flaky', { runs: 2 }, 360_000);
  contains('diagnose-flaky defaults to the last failed test', consistent.text, '## Flaky diagnosis — `tests/fail.spec.ts` × 2 runs');
  contains('diagnose-flaky verdict: CONSISTENTLY FAILING', consistent.text, '**CONSISTENTLY FAILING** — failed all 2 run(s)');

  // Quarantine: the broken test keeps running and is reported, but stops
  // failing the run; removing the entry makes it block again.
  const noOwner = await callTool(client, 'quarantine', { action: 'add', index: 1 }, 30_000);
  check('quarantine refuses an entry without an owner and reason', noOwner.isError && noOwner.text.includes('owner'), noOwner.text.slice(0, 300));
  const quarantined = await callTool(client, 'quarantine', { action: 'add', index: 1, owner: '@qa', reason: 'cart API 404, tracked in #42', days: 7 }, 30_000);
  check('quarantine adds the last failure with an owner and expiry', quarantined.result.structuredContent?.status === 'added' && quarantined.text.includes('@qa') && quarantined.text.includes('› checkout save button surfaces cart errors until'), quarantined.text.slice(0, 400));
  const shielded = await callTool(client, 'run-test', { testFiles: ['tests/fail.spec.ts'], retryOnFailure: false }, 180_000);
  check(
    'a quarantined failure is reported but does not fail the run',
    shielded.result.structuredContent?.ok === true && shielded.result.structuredContent?.run?.quarantined === 1 && shielded.text.includes('1 quarantined') && shielded.text.includes('save-btn'),
    shielded.text.slice(0, 600),
  );
  const released = await callTool(client, 'quarantine', { action: 'remove', test: 'tests/fail.spec.ts › checkout save button surfaces cart errors' }, 30_000);
  check('quarantine remove ends it', released.result.structuredContent?.status === 'removed' && released.result.structuredContent?.total === 0, released.text.slice(0, 300));

  rmSync(path.join(fixtureRoot, 'tests', '.flaky-marker'), { force: true });
  const flaky = await callTool(client, 'run-test', { testFiles: ['tests/flaky.spec.ts'] }, 180_000);
  contains('auto-retry turns the first-run failure into FLAKY', flaky.text, '✅ PASSED (1 flaky)');
  contains('flaky run shows the auto retry meta line', flaky.text, 'auto retry ×1');
  contains('flaky run warns about flaky tests', flaky.text, '1 flaky test(s)');

  rmSync(path.join(fixtureRoot, 'tests', '.flaky-marker'), { force: true });
  const diagnosis = await callTool(client, 'diagnose-flaky', { testFiles: ['tests/flaky.spec.ts'], runs: 3 }, 360_000);
  contains('diagnose-flaky runs with retries disabled', diagnosis.text, 'Playwright retries disabled');
  contains('diagnose-flaky verdict: FLAKY (2 of 3)', diagnosis.text, '**FLAKY** — 2 of 3 run(s) passed');
  contains('diagnose-flaky repeats in one process', diagnosis.text, 'one Playwright process with `--repeat-each=3`');
  contains('diagnose-flaky table shows 2 passes + 1 failure per test', diagnosis.text, '| `tests/flaky.spec.ts:17` inventory sync retries until the marker exists [chromium] | 2 | 1 |');

  // A test that fails only when copies of it run at the same time: the
  // isolate pass must call it a parallelism bug, not plain flakiness.
  writeFileSync(
    path.join(fixtureRoot, 'tests', 'slot.spec.ts'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { expect, test } from '@playwright/test';",
      '',
      "test('shared slot is free', async () => {",
      "  const lock = path.join(__dirname, '.slot-lock');",
      '  let fd: number | undefined;',
      "  try { fd = fs.openSync(lock, 'wx'); } catch { /* another copy holds it */ }",
      "  expect(fd, 'slot already taken by a parallel run').toBeDefined();",
      '  await new Promise((resolve) => setTimeout(resolve, 1500));',
      '  fs.closeSync(fd!);',
      '  fs.rmSync(lock, { force: true });',
      '});',
      '',
    ].join('\n'),
  );
  const isolated = await callTool(client, 'diagnose-flaky', { testFiles: ['tests/slot.spec.ts'], runs: 3, isolate: true, workers: 3 }, 360_000);
  contains('isolate runs the parallel pass fully parallel', isolated.text, '`--workers=3`, `--fully-parallel`');
  contains('isolate compares parallel with alone', isolated.text, '### Parallel vs alone');
  contains('isolate reads the shared slot as a parallelism bug', isolated.text, '🔀 **fails only in parallel**');
  contains('isolate shows every run alone passing', isolated.text, '3/3 passed');
  rmSync(path.join(fixtureRoot, 'tests', 'slot.spec.ts'), { force: true });
  rmSync(path.join(fixtureRoot, 'tests', '.slot-lock'), { force: true });

  // Order dependence: the checkout test passes only when the add-to-cart
  // test ran first in the same worker. PW_MCP_SHUFFLE_SEEDS (set in main)
  // pins the random orders: seeds 1 and 2 keep file order, seed 4 flips it.
  writeFileSync(
    path.join(fixtureRoot, 'tests', 'order.spec.ts'),
    [
      "import { expect, test } from '@playwright/test';",
      '',
      'const cart = globalThis as { __cart?: string[] };',
      '',
      "test('adds a book to the cart', async () => {",
      "  cart.__cart = ['book'];",
      '  expect(cart.__cart).toHaveLength(1);',
      '});',
      '',
      "test('checkout lists the book', async () => {",
      "  expect(cart.__cart ?? []).toContain('book');",
      '});',
      '',
    ].join('\n'),
  );
  const ordered = await callTool(client, 'diagnose-flaky', { testFiles: ['tests/order.spec.ts'], runs: 3, order: true }, 600_000);
  contains('order: plain repeats see nothing wrong', ordered.text, '**NOT REPRODUCING**');
  contains('order: shuffled runs are reported', ordered.text, '### Test order (`--shuffle`, one worker)');
  contains('order: the dependent test is read as order dependent', ordered.text, '🔗 **order dependent**');
  contains('order: it names the test it relies on', ordered.text, 'Relies on: `adds a book to the cart`');
  contains('order: it hands back the reproducing seed', ordered.text, '--shuffle=4');
  rmSync(path.join(fixtureRoot, 'tests', 'order.spec.ts'), { force: true });

  const generatedPath = path.join(fixtureRoot, 'tests', 'generated', 'click-the-call-to-action-button.spec.ts');
  const generate = await callTool(client, 'generate-e2e-test', { description: 'click the call to action button', pageUrl: origin }, 120_000);
  contains('generate-e2e-test renders the scaffold', generate.text, '## 🧪 Generated test');
  contains('generate-e2e-test reports the target file', generate.text, 'tests/generated/click-the-call-to-action-button.spec.ts');
  contains('generate-e2e-test records the entry URL', generate.text, '**Entry URL:**');
  const wrote = existsSync(generatedPath) && statSync(generatedPath).isFile();
  check('generated spec exists on disk', wrote, generatedPath);
  if (wrote) {
    const source = readFileSync(generatedPath, 'utf8');
    contains('generated spec contains a Playwright test', source, 'test(');
  }

  const walkPath = path.join(fixtureRoot, 'tests', 'generated', 'rename-in-settings.spec.ts');
  const walk = await callTool(
    client,
    'generate-e2e-test',
    {
      description: 'rename in settings',
      pageUrl: `${origin}/account`,
      storageState: '.auth/user.json',
      assertScope: 'dialog',
      steps: [
        { type: 'click', locator: "getByRole('button', { name: 'Open settings' })" },
        { type: 'fill', locator: "getByLabel('Nickname')", value: 'Ada' },
      ],
    },
    180_000,
  );
  contains('walk: every step ran on the live page', walk.text, '**Walked:** 2 step(s)');
  contains('walk: the spec replays the steps', walk.text, "await page.getByLabel('Nickname').fill('Ada');");
  contains('walk: the end state is asserted', walk.text, 'textbox "Nickname": Ada');
  contains('walk: the spec reuses the signed-in session', walk.text, "test.use({ storageState: '.auth/user.json' });");
  contains('walk: the written spec passes its first run', walk.text, '✅ Verified');
  rmSync(walkPath, { force: true });
  const badWalk = await callTool(client, 'generate-e2e-test', { description: 'bad walk', pageUrl: origin, steps: [{ type: 'click', locator: "getByRole('button', { name: 'Nope' })" }] }, 90_000);
  check('walk: a broken step writes nothing', badWalk.isError && badWalk.text.includes('Nothing was written') && !existsSync(path.join(fixtureRoot, 'tests', 'generated', 'bad-walk.spec.ts')), badWalk.text.slice(0, 400));
}

async function phaseHistoryAndHeal(client) {
  const ranking = await callTool(client, 'analyze-history', {}, 30_000);
  contains('analyze-history ranks the flaky fixture test', ranking.text, '### ⚠️ Flaky');
  contains('analyze-history names flaky.spec.ts', ranking.text, 'tests/flaky.spec.ts');
  contains('analyze-history lists the always-failing test as broken', ranking.text, '### ❌ Broken');
  check('history file written inside the project', existsSync(path.join(fixtureRoot, '.playwright-e2e-mcp', 'history.jsonl')), 'missing history.jsonl');
  check('history folder ignores itself in git', existsSync(path.join(fixtureRoot, '.playwright-e2e-mcp', '.gitignore')), 'missing .gitignore');

  const patterns = await callTool(client, 'analyze-history', { view: 'patterns' }, 30_000);
  contains('analyze-history groups failures by cause', patterns.text, '## Failure patterns');
  const slow = await callTool(client, 'analyze-history', { view: 'slow' }, 30_000);
  contains('analyze-history lists the slowest tests', slow.text, '## Slowest tests');
  const trend = await callTool(client, 'analyze-history', { view: 'trend' }, 30_000);
  contains('analyze-history shows stability by day', trend.text, '## Stability by day');
  const commits = await callTool(client, 'analyze-history', { view: 'commits' }, 30_000);
  contains('analyze-history shows when tests went bad', commits.text, '## When each test went bad');
  const timeline = await callTool(client, 'analyze-history', { test: 'inventory sync' }, 30_000);
  contains('analyze-history shows one test timeline', timeline.text, '**Timeline (oldest → newest):**');

  // audit-tests: finds the risks, rewrites the one-shot assertion, proves it and keeps it.
  const auditPath = path.join(fixtureRoot, 'tests', 'audit-me.spec.ts');
  writeFileSync(
    auditPath,
    [
      "import { expect, test } from '@playwright/test';",
      '',
      "test('cta shows', async ({ page }) => {",
      "  await page.goto('/');",
      '  await page.waitForTimeout(50);',
      "  expect(await page.getByTestId('cta-button').isVisible()).toBe(true);",
      '});',
      '',
    ].join('\n'),
  );
  const audit = await callTool(client, 'audit-tests', { filter: 'audit-me' }, 60_000);
  contains('audit-tests flags the hard wait', audit.text, '**hard-wait** `tests/audit-me.spec.ts:5`');
  contains('audit-tests offers the web-first rewrite', audit.text, "Fix: `await expect(page.getByTestId('cta-button')).toBeVisible();`");
  check('audit-tests returns findings as data', audit.result.structuredContent?.findings?.length === 2, JSON.stringify(audit.result.structuredContent).slice(0, 300));
  const audited = await callTool(client, 'audit-tests', { filter: 'audit-me', fix: true }, 180_000);
  contains('audit-tests fix is verified by a re-run', audited.text, 'Verified: the touched files pass');
  check(
    'audit-tests fix keeps the rewrite and leaves the hard wait for a person',
    readFileSync(auditPath, 'utf8').includes("  await expect(page.getByTestId('cta-button')).toBeVisible();") && readFileSync(auditPath, 'utf8').includes('waitForTimeout(50)'),
    readFileSync(auditPath, 'utf8'),
  );
  rmSync(auditPath, { force: true });

  const started = await callTool(client, 'run-test', { testFiles: ['tests/pass.spec.ts'], background: true }, 30_000);
  const runId = /`(run-[a-z0-9-]+)`/.exec(started.text)?.[1];
  check('run-test background returns a run id at once', Boolean(runId), started.text.slice(0, 300));
  const status = await callTool(client, 'get-run-status', { runId, waitSeconds: 55 }, 90_000);
  contains('get-run-status returns the finished result', status.text, '✅ PASSED');
  contains('get-run-status labels the background run', status.text, `Background run \`${runId}\``);

  // A renamed test id: the element is still there, the locator drifted.
  const healPath = path.join(fixtureRoot, 'tests', 'heal.spec.ts');
  writeFileSync(
    healPath,
    [
      "import { expect, test } from '@playwright/test';",
      '',
      "test('buy button still works', async ({ page }) => {",
      "  await page.goto('/');",
      "  await page.getByTestId('buy-button').click({ timeout: 3000 });",
      "  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
      '});',
      '',
    ].join('\n'),
  );
  const broken = await callTool(client, 'run-test', { testFiles: ['tests/heal.spec.ts'], retryOnFailure: false }, 180_000);
  contains('drifted locator fails first', broken.text, 'buy-button');
  const proposal = await callTool(client, 'suggest-fix', {}, 90_000);
  contains('suggest-fix proposes the role locator', proposal.text, "+  await page.getByRole('button', { name: 'Buy now' }).click({ timeout: 3000 });");
  contains('suggest-fix rates it high confidence', proposal.text, 'confidence **high**');
  const proposed = proposal.result.structuredContent;
  check(
    'suggest-fix returns the fix as structured data',
    proposed?.applied === false && proposed.fix?.file === 'tests/heal.spec.ts' && proposed.fix.after.includes("getByRole('button', { name: 'Buy now' })") && proposed.fix.before.includes('buy-button'),
    JSON.stringify(proposed).slice(0, 400),
  );
  check('suggest-fix without apply leaves the file alone', readFileSync(healPath, 'utf8').includes("getByTestId('buy-button')"), 'file changed');
  // Heal guard: the locator fix keeps the assertion; a "fix" that deletes it is blocked.
  const healText = readFileSync(healPath, 'utf8');
  const fairFix = await callTool(client, 'check-test-change', { file: 'tests/heal.spec.ts', after: healText.replace("getByTestId('buy-button')", "getByRole('button', { name: 'Buy now' })") }, 30_000);
  check('check-test-change passes a locator fix that keeps the assertion', fairFix.result.structuredContent?.status === 'OK' && fairFix.result.structuredContent?.ok === true, fairFix.text.slice(0, 400));
  const cheat = healText.split('\n').filter((line) => !line.includes('expect(')).join('\n');
  const cheated = await callTool(client, 'check-test-change', { file: 'tests/heal.spec.ts', after: cheat }, 30_000);
  check(
    'check-test-change blocks a fix that deletes the assertion',
    cheated.result.structuredContent?.status === 'BLOCK' && cheated.result.structuredContent?.findings?.some((f) => f.rule === 'assertions-removed'),
    cheated.text.slice(0, 400),
  );
  const skipped = await callTool(client, 'check-test-change', { file: 'tests/heal.spec.ts', after: healText.replace("test('buy", "test.skip('buy") }, 30_000);
  check('check-test-change blocks a fix that skips the test', skipped.result.structuredContent?.status === 'BLOCK', skipped.text.slice(0, 400));
  const applied = await callTool(client, 'suggest-fix', { apply: true }, 180_000);
  contains('suggest-fix apply verifies with a re-run', applied.text, '### ✅ Verified');
  check('suggest-fix reports verified: true', applied.result.structuredContent?.verified === true, JSON.stringify(applied.result.structuredContent).slice(0, 300));
  contains('the spec now uses the healed locator', readFileSync(healPath, 'utf8'), "getByRole('button', { name: 'Buy now' })");
  rmSync(healPath, { force: true });

  // A locator that now matches two elements: strict mode violation.
  const strictPath = path.join(fixtureRoot, 'tests', 'strict.spec.ts');
  writeFileSync(
    strictPath,
    [
      "import { test } from '@playwright/test';",
      '',
      "test('saves the form', async ({ page }) => {",
      "  await page.setContent('<button>Save</button><button>Save draft</button>');",
      "  await page.getByRole('button', { name: 'Save' }).click({ timeout: 3000 });",
      '});',
      '',
    ].join('\n'),
  );
  const strictRun = await callTool(client, 'run-test', { testFiles: ['tests/strict.spec.ts'], retryOnFailure: false }, 180_000);
  contains('ambiguous locator fails with a strict mode violation', strictRun.text, 'strict mode violation');
  const strictFix = await callTool(client, 'suggest-fix', { apply: true }, 180_000);
  contains('suggest-fix picks the exact-name match', strictFix.text, "+  await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 3000 });");
  contains('suggest-fix verifies the strict-mode fix', strictFix.text, '### ✅ Verified');
  rmSync(strictPath, { force: true });
}

async function phaseErrorPaths(client) {
  const missing = await callTool(client, 'run-test', { testFiles: ['tests/does-not-exist.spec.ts'] }, 60_000);
  check(
    'run-test rejects a missing test path (INVALID_PATH)',
    missing.isError && missing.text.includes('INVALID_PATH') && missing.text.includes('not found'),
    missing.text.slice(0, 300),
  );

  let unknownOk = false;
  let unknownDetail = '';
  try {
    const result = await client.request('tools/call', { name: 'definitely-not-a-tool', arguments: {} }, 30_000);
    unknownOk = result?.isError === true;
    unknownDetail = `server answered with isError=${result?.isError}`;
  } catch (error) {
    unknownOk = true;
    unknownDetail = error.message;
  }
  check('unknown tool call is rejected', unknownOk, unknownDetail);
}

async function phaseProfilesAndCi(origin) {
  const env = {
    ...process.env,
    PW_MCP_PROJECT_ROOT: fixtureRoot,
    FIXTURE_PORT: new URL(origin).port,
    LOG_LEVEL: 'warn',
    FORCE_COLOR: '0',
  };

  // A tool profile trims tools/list (and the context every request carries).
  const profiled = new McpClient(
    spawn(process.execPath, [serverEntry, '--tools=core,inspect-page'], { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  );
  try {
    await profiled.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-profile', version: '1.0.0' } }, 30_000);
    profiled.notify('notifications/initialized');
    const list = await profiled.request('tools/list', {}, 30_000);
    const names = (list.tools ?? []).map((tool) => tool.name).sort();
    const expected = ['check-test-change', 'diagnose-flaky', 'get-failure', 'get-run-status', 'inspect-page', 'list-tests', 'run-test', 'suggest-fix'];
    check('--tools=core,inspect-page exposes exactly that set', JSON.stringify(names) === JSON.stringify(expected), `got ${JSON.stringify(names)}`);
  } finally {
    await profiled.stop();
  }

  // The ci command: same diagnosis, as a CI step with a Markdown report.
  const reportPath = path.join(fixtureRoot, 'test-results', 'ci-report.md');
  const summaryPath = path.join(fixtureRoot, 'test-results', 'step-summary.md');
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const ci = await new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [serverEntry, 'ci', '--output', reportPath, '--flaky-runs', '2', '--suggest', '1', 'tests/pass.spec.ts', 'tests/fail.spec.ts'],
      { cwd: fixtureRoot, env: { ...env, GITHUB_STEP_SUMMARY: summaryPath }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
  check('ci exits 1 when tests fail', ci.code === 1, `exit ${ci.code}`);
  contains('ci report names the failing test', ci.stdout, 'tests/fail.spec.ts:9');
  contains('ci report carries the flaky verdict', ci.stdout, '### Flaky diagnosis');
  contains('ci report carries the suggest-fix section', ci.stdout, 'Fix for failure 1');
  check('ci writes the --output report', existsSync(reportPath) && readFileSync(reportPath, 'utf8') === ci.stdout, reportPath);
  check('ci appends to the GitHub job summary', existsSync(summaryPath) && readFileSync(summaryPath, 'utf8').includes('## Playwright run'), summaryPath);

  // --verify-fixes: the fix is tried, the test passes, and the file is restored.
  const healPath = path.join(fixtureRoot, 'tests', 'ci-heal.spec.ts');
  const healSource = [
    "import { expect, test } from '@playwright/test';",
    '',
    "test('buy button still works', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.getByTestId('buy-button').click({ timeout: 3000 });",
    "  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
    '});',
    '',
  ].join('\n');
  writeFileSync(healPath, healSource);
  const fixesPath = path.join(fixtureRoot, 'test-results', 'fixes.json');
  const verifyRun = await new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [serverEntry, 'ci', '--no-retry', '--suggest', '1', '--verify-fixes', '--suggestions', fixesPath, 'tests/ci-heal.spec.ts'],
      { cwd: fixtureRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
  contains('ci --verify-fixes reports the fix as verified', verifyRun.stdout, 'Verified in CI');
  // Paths are relative to the repository on Actions (GITHUB_WORKSPACE), to the project elsewhere.
  const healRepoPath = path.relative(process.env.GITHUB_WORKSPACE ?? fixtureRoot, healPath).split(path.sep).join('/');
  const fixes = existsSync(fixesPath) ? JSON.parse(readFileSync(fixesPath, 'utf8')) : [];
  check(
    'ci --suggestions writes the verified fix',
    fixes.length === 1 && fixes[0].path === healRepoPath && fixes[0].line === 5 && fixes[0].verified === true,
    JSON.stringify(fixes).slice(0, 400),
  );
  check('ci --verify-fixes restores the spec afterwards', readFileSync(healPath, 'utf8') === healSource, readFileSync(healPath, 'utf8').slice(0, 300));
  rmSync(healPath, { force: true });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();

  if (!existsSync(serverEntry)) {
    process.stderr.write(`e2e: ${serverEntry} not found — run \`npm run e2e\` (it builds first) or \`npm run build\`.\n`);
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  cleanFixture();

  const fixture = await startFixtureServer();
  flipFixture = fixture.flip;
  fixtureState = fixture.state;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PW_MCP_PROJECT_ROOT: fixtureRoot,
      FIXTURE_PORT: new URL(fixture.origin).port,
      PW_MCP_SHUFFLE_SEEDS: '1,4,2',
      E2E_PASSWORD: LOGIN_PASSWORD,
      E2E_TOTP_SECRET: LOGIN_TOTP_SECRET,
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      FORCE_COLOR: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const client = new McpClient(child);
  let fatal = null;

  try {
    await phaseHandshake(client, pkg);
    await phaseLivePage(client, fixture.origin);
    await phaseTestRuns(client, fixture.origin);
    await phaseHistoryAndHeal(client);
    await phaseErrorPaths(client);
    await phaseProfilesAndCi(fixture.origin);
  } catch (error) {
    fatal = error;
    check(`harness aborted: ${error?.message ?? error}`, false, error?.stack);
  } finally {
    const exited = await client.stop();
    check('MCP server shuts down cleanly (exit 0)', exited?.code === 0, `exit=${JSON.stringify(exited)}`);
    await fixture.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`Integration suite: ${checks.length - failed.length}/${checks.length} checks passed (${elapsed}s)\n`);

  if (failed.length > 0 || fatal) {
    process.stdout.write('\nFailures:\n');
    for (const entry of failed) process.stdout.write(`  - ${entry.name}\n`);
    const stderr = client.stderr.trim();
    if (stderr !== '') {
      process.stdout.write(`\nServer stderr (tail):\n${stderr.slice(-4_000)}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`e2e: fatal — ${error?.stack ?? error}\n`);
  process.exit(1);
});
