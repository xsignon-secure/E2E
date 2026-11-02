/**
 * The browser child script behind every page-facing tool (inspect-page,
 * validate-selector, compare-visual-state, generate-e2e-test, suggest-fix).
 *
 * It runs inside a child `node` process with cwd = project root so that
 * `createRequire(projectRoot/package.json)` resolves the *user's* Playwright
 * install (browsers included). It writes one JSON document to stdout and
 * always exits, so it can never wedge the server.
 *
 * Modes:
 * - inspect     element inventory (or a compact locator map with view: 'locators')
 * - validate    resolve a selector or locator chain, count and describe matches
 * - screenshot  capture the page or one element
 * - heal        rank elements that look like a broken locator's target, either
 *               on the live page or on a DOM snapshot taken from a trace
 * - a11y        run axe-core on the page (or a scoped part) and describe the
 *               offending elements, each with a verified locator
 * - perf        lab Web Vitals (LCP, CLS, TBT, INP during actions, FCP, TTFB)
 *               and the network cost per resource type, optionally under
 *               CPU and network throttling; the LCP element and the elements
 *               that shifted come back with verified locators
 *
 * Any mode that navigates applies the caller's network mocks (cfg.routes)
 * first and reports how many requests each one handled.
 *
 * Every element the script reports carries Playwright locators that were
 * proven, in this same page, to resolve to exactly that one element.
 */

export const PROBE_SCRIPT = String.raw`
'use strict';
const cfg = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));

function send(payload) {
  try { process.stdout.write(JSON.stringify(payload)); } catch (err) { /* ignore */ }
}

function classifyError(message) {
  const m = String(message);
  if (/browserType\.connect|connectOverCDP/.test(m)) {
    if (/version|428|Precondition/i.test(m)) {
      return { kind: 'NAVIGATION_FAILED', hint: 'The remote browser runs another Playwright version. Match it: device clouds take the client version in their capabilities (e.g. client.playwrightVersion), run-server must use the same @playwright/test as the project.' };
    }
    return { kind: 'NAVIGATION_FAILED', hint: 'Could not reach the remote browser. Check the endpoint, the access key (in an {{env:…}} variable) and that the service or npx playwright run-server is running.' };
  }
  if (/Unknown device preset/.test(m)) {
    return { kind: 'INVALID_INPUT', hint: 'Use a name from Playwright\'s device list, e.g. "iPhone 15", "Pixel 7", "iPad Pro 11" or "Desktop Chrome".' };
  }
  if (/distribution '([^']+)' is not found|Chromium distribution/i.test(m)) {
    return { kind: 'NO_PLAYWRIGHT', hint: 'That browser channel is not installed on this machine. Install it with: npx playwright install chrome (or msedge), or leave channel unset.' };
  }
  if (/Executable doesn't exist|Please run the following command to install/i.test(m)) {
    return { kind: 'NO_PLAYWRIGHT', hint: 'Playwright browsers are not installed for this project. Run: npx playwright install chromium (or firefox / webkit for those engines)' };
  }
  if (/ERR_TOO_MANY_REDIRECTS/.test(m)) {
    return { kind: 'NAVIGATION_FAILED', hint: 'The page redirects in a loop. This is often a login redirect: pass storageState or log in with actions, or check the URL.' };
  }
  if (/ERR_UNSAFE_PORT/.test(m)) {
    return { kind: 'NAVIGATION_FAILED', hint: 'Browsers refuse to open this port. Serve the app on another port, such as 3000 or 8080.' };
  }
  if (/ERR_CERT_|SSL_ERROR|SEC_ERROR/.test(m)) {
    return { kind: 'NAVIGATION_FAILED', hint: 'The site\'s TLS certificate was rejected. Use http:// locally, or a certificate the browser trusts.' };
  }
  if (/^Action step/.test(m) && /intercepts pointer events/.test(m)) {
    return { kind: 'TIMEOUT', hint: 'Another element covers the target (see the call log): close the overlay, dialog or cookie banner with an earlier action, or wait for it to go.' };
  }
  if (/^Action step/.test(m) && /Timeout \d+ms exceeded/.test(m)) {
    return { kind: 'TIMEOUT', hint: 'The step waited for its element to appear, be visible, enabled and uncovered. Check the locator with validate-selector using the earlier steps as actions. An element inside an iframe needs frameLocator(\'#frame\') first. If the element is only slow, raise actionTimeoutMs (and timeoutMs).' };
  }
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|getaddrinfo|net::ERR_/i.test(m)) {
    return { kind: 'SERVER_NOT_RUNNING', hint: 'The URL is not reachable. Start your dev server (e.g. npm run dev / npm start) and retry.' };
  }
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) {
    return { kind: 'TIMEOUT', hint: 'Raise timeoutMs, or make the page load faster.' };
  }
  if (/Target closed|browser has been closed|browser has crashed|Page crashed/i.test(m)) {
    return { kind: 'BROWSER_CRASH', hint: 'The browser crashed during inspection. Retry; if it persists run: npx playwright install --force' };
  }
  if (/Unknown selector|error evaluating selector|Unexpected token|is not a valid selector|Unknown engine/i.test(m)) {
    return { kind: 'INVALID_INPUT', hint: 'The selector could not be evaluated.' };
  }
  return { kind: 'UNKNOWN', hint: undefined };
}

async function startGuardProxy(ranges) {
  const http = require('node:http');
  const net = require('node:net');
  const dns = require('node:dns').promises;
  const blocked = new net.BlockList();
  for (const r of ranges) blocked.addSubnet(r.address, r.prefix, r.family);
  const isBlocked = (a) => {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
    if (m) return blocked.check(m[1], 'ipv4');
    const f = net.isIP(a);
    return f === 4 ? blocked.check(a, 'ipv4') : f === 6 ? blocked.check(a, 'ipv6') : true;
  };
  // Resolve once and connect to that exact address, so DNS cannot change
  // between the check and the connection.
  const allowedAddress = async (host) => {
    const bare = host.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(bare) ? [bare] : (await dns.lookup(bare, { all: true, verbatim: true })).map((x) => x.address);
    if (addrs.length === 0 || addrs.some(isBlocked)) return null;
    return addrs[0];
  };
  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch (err) {
      res.writeHead(400);
      res.end();
      return;
    }
    const ip = await allowedAddress(target.hostname).catch(() => null);
    if (!ip) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked by playwright-e2e-mcp: private or reserved address');
      return;
    }
    const upstream = http.request(
      { host: ip, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => undefined);
    let target;
    try {
      target = new URL('http://' + req.url);
    } catch (err) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const ip = await allowedAddress(target.hostname).catch(() => null);
    if (!ip) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(target.port) || 443, ip, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return server.address().port;
}

/* ---------------- locator chains (JSON, never evaluated as code) ---------------- */

function reviveArg(arg) {
  if (arg && typeof arg === 'object') {
    if (typeof arg.$regex === 'string') return new RegExp(arg.$regex, arg.flags || '');
    const out = {};
    for (const key of Object.keys(arg)) out[key] = reviveArg(arg[key]);
    return out;
  }
  return arg;
}

const CHAIN_METHODS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'locator', 'first', 'last', 'nth', 'filter', 'frameLocator', 'contentFrame']);
const FRAME_STEPS = new Set(['frameLocator', 'contentFrame']);

// The part of a chain up to its last iframe step, and the part inside that frame.
function splitFrameChain(chain) {
  let cut = 0;
  chain.forEach((call, i) => { if (FRAME_STEPS.has(call.method)) cut = i + 1; });
  return { frame: chain.slice(0, cut), inner: chain.slice(cut) };
}

// Install the in-page helpers in every frame, so elements inside iframes can be described.
async function installHelpersEverywhere(page) {
  await page.evaluate(installHelpers);
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) await frame.evaluate(installHelpers).catch(() => undefined);
  }
}

// Playwright's call log, the lines after "Call log:", trimmed to the last few.
function callLogOf(message) {
  const at = message.indexOf('Call log:');
  if (at < 0) return '';
  return message.slice(at + 9).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-8).join('\n');
}

function resolveChain(page, chain) {
  let target = page;
  for (const call of chain) {
    if (!CHAIN_METHODS.has(call.method)) throw new Error('Unsupported locator method ' + call.method);
    target = target[call.method](...(call.args || []).map(reviveArg));
  }
  return target;
}

/* ---------------- in-page helpers, installed once per page ---------------- */

function installHelpers() {
  if (window.__pwmcp) return;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function uniqueSelector(el) {
    if (el.id) {
      const css = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try { if (document.querySelectorAll(css).length === 1) return css; } catch (err) { /* fall through */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node === document.documentElement) { parts.unshift('html'); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (siblings.length > 1) part = part + ':nth-of-type(' + (Array.prototype.indexOf.call(siblings, node) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (err) { /* keep walking */ }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    switch (tag) {
      case 'button': return 'button';
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'input':
        if (type === 'hidden') return null;
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['', 'text', 'email', 'tel', 'url'].includes(type)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
        return null;
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return el.getAttribute('alt') === '' ? null : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'option': return 'option';
      case 'dialog': return 'dialog';
      case 'progress': return 'progressbar';
      case 'article': return 'article';
      case 'form': return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'form' : null;
      default: return null;
    }
  }

  function labelText(el) {
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (lab) return norm(lab.textContent);
      } catch (err) { /* ignore */ }
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return '';
  }

  function accessibleName(el, role) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => norm(n.textContent)).join(' ');
      if (text) return text;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return norm(el.value || el.getAttribute('value'));
      if (type === 'image') return norm(el.getAttribute('alt'));
      const label = labelText(el);
      if (label) return label;
      return norm(el.getAttribute('title') || el.getAttribute('placeholder'));
    }
    if (tag === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title'));
    const fromContent = ['button', 'link', 'heading', 'cell', 'columnheader', 'option', 'tab', 'menuitem', 'listitem', 'checkbox', 'radio', 'switch', 'treeitem'];
    if (fromContent.includes(role)) return norm(el.innerText !== undefined && el.innerText !== '' ? el.innerText : el.textContent);
    return norm(el.getAttribute('title'));
  }

  function isVisible(el) {
    let visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    try {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') visible = false;
    } catch (err) { /* ignore */ }
    return visible;
  }

  // Ordered candidate locators, best first. The Node side keeps only those
  // that resolve to exactly this element.
  function candidates(el) {
    const out = [];
    const role = implicitRole(el);
    const name = role ? accessibleName(el, role) : '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    const testAttr = el.hasAttribute('data-testid') ? 'data-testid' : null;
    if (role && name && name.length <= 80) {
      out.push([{ method: 'getByRole', args: [role, { name: name }] }]);
      out.push([{ method: 'getByRole', args: [role, { name: name, exact: true }] }]);
    }
    if (testId && testAttr) out.push([{ method: 'getByTestId', args: [testId] }]);
    else if (testId) out.push([{ method: 'locator', args: ['[' + (el.hasAttribute('data-test-id') ? 'data-test-id' : 'data-test') + '="' + testId + '"]'] }]);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const label = labelText(el);
      if (label && label.length <= 80) out.push([{ method: 'getByLabel', args: [label] }]);
      const placeholder = norm(el.getAttribute('placeholder'));
      if (placeholder) out.push([{ method: 'getByPlaceholder', args: [placeholder] }]);
    }
    const alt = norm(el.getAttribute('alt'));
    if (alt) out.push([{ method: 'getByAltText', args: [alt] }]);
    const text = norm(el.textContent);
    if (text && text.length <= 50 && el.children.length === 0 && !['html', 'head', 'body', 'script', 'style', 'title'].includes(tag)) {
      out.push([{ method: 'getByText', args: [text] }]);
      out.push([{ method: 'getByText', args: [text, { exact: true }] }]);
    }
    if (role && !name) out.push([{ method: 'getByRole', args: [role] }]);
    const title = norm(el.getAttribute('title'));
    if (title) out.push([{ method: 'getByTitle', args: [title] }]);
    out.push([{ method: 'locator', args: [uniqueSelector(el)] }]);
    return { chains: out, role: role || undefined, name: name || undefined };
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    const attributes = {};
    const attrCount = Math.min(el.attributes.length, 30);
    for (let i = 0; i < attrCount; i += 1) {
      const attr = el.attributes[i];
      attributes[attr.name] = String(attr.value).slice(0, 200);
    }
    const info = candidates(el);
    const text = norm(el.textContent).slice(0, 160);
    return {
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.prototype.slice.call(el.classList).slice(0, 10),
      role: info.role,
      name: info.name ? info.name.slice(0, 120) : undefined,
      text: text || undefined,
      attributes: attributes,
      visible: isVisible(el),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      candidates: info.chains,
    };
  }

  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option', 'heading', 'img', 'dialog', 'navigation', 'main', 'form']);

  function isMeaningful(el) {
    if (!isVisible(el)) return false;
    const role = implicitRole(el);
    if (role && INTERACTIVE.has(role)) return true;
    return el.hasAttribute('data-testid') || el.hasAttribute('data-test-id') || el.hasAttribute('data-test');
  }

  // Token overlap between a broken locator's words and an element.
  function healScore(el, tokens) {
    if (tokens.length === 0) return 0;
    const info = candidates(el);
    const hay = [
      el.id, el.getAttribute('data-testid'), el.getAttribute('data-test-id'), el.getAttribute('data-test'),
      el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
      el.getAttribute('alt'), info.name, el.children.length === 0 ? el.textContent : '', el.className && typeof el.className === 'string' ? el.className : '',
    ].filter(Boolean).join(' ').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2');
    const words = new Set(hay.split(/[^a-z0-9]+/).filter((w) => w.length > 1));
    let score = 0;
    for (const token of tokens) {
      if (words.has(token)) score += 3;
      else if (Array.from(words).some((w) => w.startsWith(token) || token.startsWith(w))) score += 2;
      else if (hay.includes(token)) score += 1;
    }
    if (cfgRole() && info.role === cfgRole()) score += 2;
    if (info.role && INTERACTIVE.has(info.role)) score += 1;
    return score;
  }
  let roleHint = null;
  const cfgRole = () => roleHint;

  window.__pwmcp = {
    describe: describe,
    uniqueSelector: uniqueSelector,
    isMeaningful: isMeaningful,
    healScore: healScore,
    setRoleHint: (r) => { roleHint = r || null; },
    els: [],
  };
}

/* ---------------- locator verification ---------------- */

async function verifyCandidates(page, index, candidates, keep) {
  const verified = [];
  for (const chain of candidates || []) {
    if (verified.length >= keep) break;
    try {
      const loc = resolveChain(page, chain);
      if ((await loc.count()) !== 1) continue;
      const same = await loc.evaluate((el, i) => el === window.__pwmcp.els[i], index);
      if (!same) continue;
      // Skip the exact:true twin when the plain form already passed.
      const key = JSON.stringify(chain.map((c) => [c.method, (c.args || []).map((a) => {
        if (!a || typeof a !== 'object' || a.$regex) return a;
        const copy = Object.assign({}, a);
        delete copy.exact;
        return copy;
      })]));
      if (verified.some((v) => v.key === key)) continue;
      verified.push({ key: key, chain: chain });
    } catch (err) { /* candidate does not resolve; skip */ }
  }
  return verified.map((v) => v.chain);
}

async function attachLocators(page, elements, budget, keep) {
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (i < budget) el.locators = await verifyCandidates(page, i, el.candidates, keep);
    delete el.candidates;
  }
}

/* ---------------- page actions (reach a state before inspecting) ---------------- */

/* save-login: {{env:NAME}} and {{totp}} in fill values. The values come
   in through this child's environment, never through the config file, and
   a TOTP code is generated at the moment it is typed. */
function totpCode(t, atMs) {
  const crypto = require('node:crypto');
  const counter = Math.floor(atMs / 1000 / t.period);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter % 0x100000000, 4);
  const h = crypto.createHmac(t.algorithm.toLowerCase(), Buffer.from(t.key, 'hex')).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % Math.pow(10, t.digits)).padStart(t.digits, '0');
}

async function fillValue(raw) {
  const text = raw || '';
  if (text.indexOf('{{') < 0) return text;
  const values = JSON.parse(process.env.PW_MCP_FILL_VALUES || '{}');
  const totp = process.env.PW_MCP_TOTP ? JSON.parse(process.env.PW_MCP_TOTP) : null;
  if (totp && /\{\{\s*totp\s*\}\}/.test(text)) {
    // A code with under 3 seconds left may expire before the form is sent.
    const left = totp.period - (Math.floor(Date.now() / 1000) % totp.period);
    if (left < 3) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 200));
  }
  return text.replace(/\{\{\s*(totp|env:([A-Za-z0-9_]+))\s*\}\}/g, (m, all, name) => {
    if (all === 'totp') {
      if (!totp) throw new Error('{{totp}} needs the totp option');
      return totpCode(totp, Date.now());
    }
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error('No value for {{env:' + name + '}}');
    return values[name];
  });
}

// Find the tab a switchTab step names: 'last' (default), 'first', a 1-based
// number, or text the tab's URL or title contains. Popups open
// asynchronously, so keep looking until the step's timeout.
async function findTab(context, want, timeout) {
  const target = String(want == null || want === '' ? 'last' : want).trim();
  const deadline = Date.now() + timeout;
  for (;;) {
    const pages = context.pages().filter((p) => !p.isClosed());
    let found = null;
    if (target === 'last') found = pages.length > 1 ? pages[pages.length - 1] : null;
    else if (target === 'first') found = pages[0] || null;
    else if (/^\d+$/.test(target)) found = pages[Number(target) - 1] || null;
    else {
      const needle = target.toLowerCase();
      for (const p of pages) {
        let title = '';
        try { title = await p.title(); } catch (err) { /* navigating */ }
        if (p.url().toLowerCase().indexOf(needle) >= 0 || title.toLowerCase().indexOf(needle) >= 0) { found = p; break; }
      }
    }
    if (found) return found;
    if (Date.now() >= deadline) {
      const open = [];
      for (const p of pages) open.push(p.url());
      throw new Error('No tab matches "' + target + '"; open tabs: ' + (open.length ? open.join(', ') : 'none'));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Every open tab, for the tool output when an action opened more than one.
async function listTabs(context, active) {
  const tabs = [];
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    let title = '';
    try { title = await p.title(); } catch (err) { /* navigating */ }
    tabs.push({ url: p.url(), title: String(title).slice(0, 200), active: p === active });
  }
  return tabs;
}

async function runActions(page, actions, timeout) {
  const done = [];
  let current = page;
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const label = 'step ' + (i + 1) + ' (' + (a.label || a.type) + ')';
    try {
      if (a.type === 'switchTab') {
        current = await findTab(current.context(), a.value, timeout);
        await current.bringToFront().catch(() => undefined);
        await current.waitForLoadState('domcontentloaded', { timeout: timeout }).catch(() => undefined);
        done.push(label);
        continue;
      }
      const loc = a.locator ? resolveChain(current, a.locator) : null;
      switch (a.type) {
        case 'goto': await current.goto(a.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: timeout }); break;
        case 'click': await loc.click({ timeout: timeout }); break;
        case 'dblclick': await loc.dblclick({ timeout: timeout }); break;
        case 'hover': await loc.hover({ timeout: timeout }); break;
        case 'fill': await loc.fill(cfg.mode === 'login' ? await fillValue(a.value) : (a.value || ''), { timeout: timeout }); break;
        case 'press': if (loc) await loc.press(a.value, { timeout: timeout }); else await current.keyboard.press(a.value); break;
        case 'check': await loc.check({ timeout: timeout }); break;
        case 'uncheck': await loc.uncheck({ timeout: timeout }); break;
        case 'select': await loc.selectOption(a.value, { timeout: timeout }); break;
        case 'wait':
          if (loc) await loc.first().waitFor({ state: 'visible', timeout: timeout });
          else await current.waitForTimeout(Math.min(a.ms || 500, 10000));
          break;
        default: throw new Error('Unknown action type ' + a.type);
      }
      done.push(label);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const callLog = callLogOf(message);
      let where = '';
      try { where = current.url(); } catch (urlErr) { /* page gone */ }
      const wrapped = new Error('Action ' + label + ' failed: ' + message.split('\n')[0] + (/intercepts pointer events/.test(callLog) ? ' (another element intercepts pointer events)' : ''));
      wrapped.actionsDone = done;
      wrapped.callLog = callLog;
      wrapped.pageUrl = where;
      throw wrapped;
    }
  }
  return { done: done, page: current };
}

/* ---------------- performance (mode: perf) ---------------- */

// Runs in every new document before its own scripts, so no early paint,
// shift or long task is missed.
// Hydration watch: which framework rendered the page, whether its HTML came
// from the server, and how long controls were on screen before the
// framework attached its handlers (clicks in that window do nothing).
function hydrationInit() {
  const H = { framework: null, ssr: false, state: 'none', firstControlMs: null, hydratedMs: null, islands: 0 };
  Object.defineProperty(window, '__pwmcpHydration', { value: H, configurable: true });
  const keys = (el) => { try { return Object.keys(el); } catch (err) { return []; } };
  const hasKey = (el, prefix) => !!el && keys(el).some((k) => k.indexOf(prefix) === 0);
  const started = performance.now();
  const scan = () => {
    const d = document;
    const w = window;
    if (!d.documentElement) return false;
    const roots = [d, d.documentElement, d.body, d.getElementById('__next'), d.getElementById('root'), d.getElementById('app'), d.getElementById('__nuxt'), d.getElementById('___gatsby'), d.body && d.body.firstElementChild].filter(Boolean);
    const control = d.querySelector('button, a[href], input:not([type=hidden]), select, textarea, [role=button]');
    if (control && H.firstControlMs === null) H.firstControlMs = Math.round(performance.now());
    let fw = null;
    let ssr = false;
    let hydrated = null;
    const react = roots.some((r) => hasKey(r, '__reactContainer$')) || (control && hasKey(control, '__reactProps$'));
    const vue = roots.some((r) => r.__vue_app__ || r.__vue__);
    const islands = d.querySelectorAll('astro-island').length;
    if (w.__NEXT_DATA__ || w.__next_f) { fw = 'Next.js'; ssr = true; hydrated = react; }
    else if (w.__remixContext || w.__reactRouterContext) { fw = w.__remixContext ? 'Remix' : 'React Router'; ssr = true; hydrated = react; }
    else if (d.getElementById('___gatsby')) { fw = 'Gatsby'; ssr = true; hydrated = react; }
    else if (w.__NUXT__ || d.getElementById('__NUXT_DATA__') || d.getElementById('__nuxt')) { fw = 'Nuxt'; ssr = !!(w.__NUXT__ || d.getElementById('__NUXT_DATA__')); hydrated = vue; }
    else if (islands > 0) { fw = 'Astro'; ssr = true; H.islands = d.querySelectorAll('astro-island[ssr]').length; hydrated = H.islands === 0; }
    else if (d.querySelector('[q\\:container]')) { fw = 'Qwik'; ssr = true; hydrated = null; }
    else if (keys(w).some((k) => k.indexOf('__sveltekit') === 0)) { fw = 'SvelteKit'; ssr = true; hydrated = null; }
    else if (d.querySelector('[ng-server-context]') || d.querySelector('[ngh]')) { fw = 'Angular'; ssr = true; hydrated = null; }
    else if (d.querySelector('[data-server-rendered]')) { fw = 'Vue'; ssr = true; hydrated = vue; }
    else if (react) { fw = 'React'; hydrated = true; }
    else if (vue) { fw = 'Vue'; hydrated = true; }
    else if (d.querySelector('[ng-version]')) { fw = 'Angular'; hydrated = true; }
    H.framework = fw;
    H.ssr = ssr;
    if (hydrated === true) {
      if (H.hydratedMs === null) H.hydratedMs = Math.round(performance.now());
      H.state = 'hydrated';
      return true;
    }
    H.state = fw ? (hydrated === null ? 'unknown' : 'pending') : 'none';
    return false;
  };
  const tick = () => {
    let done = false;
    try { done = scan(); } catch (err) { /* keep watching */ }
    if (!done && performance.now() - started < 20000) setTimeout(tick, 20);
  };
  tick();
}

function perfInit() {
  const P = { lcp: null, shifts: [], longTasks: [], events: [] };
  Object.defineProperty(window, '__pwmcpPerf', { value: P, configurable: true });
  const watch = (type, fn, extra) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe(Object.assign({ type: type, buffered: true }, extra || {}));
    } catch (err) { /* entry type not supported */ }
  };
  watch('largest-contentful-paint', (e) => { P.lcp = e; });
  watch('layout-shift', (e) => { if (!e.hadRecentInput) P.shifts.push(e); });
  watch('longtask', (e) => { P.longTasks.push({ start: e.startTime, duration: e.duration }); });
  watch('event', (e) => { if (e.interactionId) P.events.push({ id: e.interactionId, duration: e.duration, name: e.name, target: e.target }); }, { durationThreshold: 16 });
}

function collectPerf() {
  const h = window.__pwmcp;
  const P = window.__pwmcpPerf || { lcp: null, shifts: [], longTasks: [], events: [] };
  h.els = [];
  const keep = (el) => {
    if (!el || el.nodeType !== 1 || !el.isConnected) return -1;
    const at = h.els.indexOf(el);
    if (at >= 0) return at;
    h.els.push(el);
    return h.els.length - 1;
  };
  const nav = performance.getEntriesByType('navigation')[0];
  const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
  const fcp = fcpEntry ? fcpEntry.startTime : undefined;

  // CLS: the worst session window (shifts < 1s apart, window <= 5s).
  let cls = 0, win = 0, winStart = 0, prev = 0, cur = [], worst = [];
  for (const s of P.shifts) {
    if (cur.length && (s.startTime - prev > 1000 || s.startTime - winStart > 5000)) { win = 0; cur = []; }
    if (!cur.length) winStart = s.startTime;
    win += s.value; cur.push(s); prev = s.startTime;
    if (win > cls) { cls = win; worst = cur.slice(); }
  }
  const shiftElements = [];
  for (const s of worst) {
    for (const src of s.sources || []) {
      const i = keep(src.node);
      if (i >= 0 && !shiftElements.includes(i) && shiftElements.length < 5) shiftElements.push(i);
    }
  }

  // TBT: blocking time of long tasks after first paint.
  let tbt = 0, longest = 0;
  for (const t of P.longTasks) {
    longest = Math.max(longest, t.duration);
    if (fcp === undefined || t.start >= fcp) tbt += Math.max(0, t.duration - 50);
  }

  // INP (lab): the slowest interaction, events grouped by interactionId.
  const byInteraction = new Map();
  for (const e of P.events) {
    const prior = byInteraction.get(e.id);
    if (!prior || e.duration > prior.duration) byInteraction.set(e.id, e);
  }
  let inp;
  for (const e of byInteraction.values()) if (!inp || e.duration > inp.duration) inp = e;
  let inpTarget;
  if (inp) {
    const i = keep(inp.target);
    inpTarget = inp.name + (i >= 0 ? ' on ' + h.describe(inp.target).tag : '');
  }

  const lcpEl = P.lcp ? P.lcp.element : null;
  const lcpElement = keep(lcpEl);
  let lcpMs;
  if (P.lcp) lcpMs = P.lcp.renderTime || P.lcp.loadTime || P.lcp.startTime;

  const timings = {};
  for (const r of performance.getEntriesByType('resource')) {
    timings[r.name] = { duration: r.duration, blocking: r.renderBlockingStatus === 'blocking' };
  }
  let heap;
  try { heap = performance.memory ? performance.memory.usedJSHeapSize : undefined; } catch (err) { /* not exposed */ }
  return {
    title: document.title,
    finalUrl: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    elements: h.els.map((el) => h.describe(el)),
    perf: {
      ttfbMs: nav ? nav.responseStart : undefined,
      fcpMs: fcp,
      lcpMs: lcpMs,
      lcpElement: lcpElement,
      lcpTag: lcpEl ? lcpEl.tagName.toLowerCase() : undefined,
      lcpUrl: P.lcp && P.lcp.url ? String(P.lcp.url).slice(0, 300) : undefined,
      cls: Math.round(cls * 1000) / 1000,
      shiftElements: shiftElements,
      tbtMs: Math.round(tbt),
      longTasks: P.longTasks.length,
      longestTaskMs: Math.round(longest),
      inpMs: inp ? Math.round(inp.duration) : undefined,
      inpTarget: inpTarget,
      domContentLoadedMs: nav && nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd : undefined,
      loadMs: nav && nav.loadEventEnd ? nav.loadEventEnd : undefined,
      domNodes: document.getElementsByTagName('*').length,
      jsHeapBytes: heap,
    },
    timings: timings,
  };
}

function registrableDomain(host) {
  const parts = String(host).split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function summariseRequests(requests, timings, pageUrl) {
  const site = registrableDomain(new URL(pageUrl).hostname);
  const byType = {};
  const all = [];
  const thirdParty = new Set();
  let thirdPartyBytes = 0;
  let total = 0;
  for (const r of requests.values()) {
    if (!r.url || /^data:|^blob:/.test(r.url)) continue;
    const bytes = r.bytes || 0;
    total += bytes;
    const type = (r.type || 'Other').toLowerCase();
    if (!byType[type]) byType[type] = { type: type, requests: 0, transferBytes: 0 };
    byType[type].requests += 1;
    byType[type].transferBytes += bytes;
    let host = '';
    try { host = new URL(r.url).hostname; } catch (err) { /* opaque */ }
    if (host && registrableDomain(host) !== site) { thirdParty.add(host); thirdPartyBytes += bytes; }
    const t = timings[r.url] || {};
    all.push({ url: r.url.slice(0, 200), type: type, transferBytes: bytes, durationMs: Math.round(t.duration || 0), renderBlocking: !!t.blocking });
  }
  return {
    requests: all.length,
    transferBytes: total,
    byType: Object.values(byType).sort((a, b) => b.transferBytes - a.transferBytes),
    largest: all.slice().sort((a, b) => b.transferBytes - a.transferBytes).slice(0, 5),
    renderBlocking: all.filter((r) => r.renderBlocking).slice(0, 8),
    thirdPartyBytes: thirdPartyBytes,
    thirdPartyOrigins: thirdParty.size,
  };
}

let serverPlaywrightVersion = '';

(async () => {
  const { createRequire } = require('node:module');
  const req = createRequire(cfg.projectRoot + '/package.json');
  let pw = null;
  try {
    pw = req('playwright');
  } catch (errA) {
    try {
      pw = req('@playwright/test');
    } catch (errB) {
      // The hosted bridge ships playwright-core next to its bundled Chromium.
      try {
        if (cfg.serverlessChromium) pw = req('playwright-core');
      } catch (errC) {}
      // No Node Playwright in the project (a pytest-playwright project):
      // use one installed next to this server, if there is one.
      // playwright-core ships with the server (a dependency), so this works
      // from npx, the .mcpb bundle and the Docker image, not just a checkout.
      if (!pw && cfg.serverRoot) {
        const own = createRequire(cfg.serverRoot + '/package.json');
        for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
          try {
            pw = own(name);
            try {
              serverPlaywrightVersion = own('playwright-core/package.json').version;
            } catch (errV) {
              serverPlaywrightVersion = 'latest';
            }
            break;
          } catch (errD) {}
        }
      }
    }
    if (!pw) {
      send({
        ok: false,
        kind: 'NO_PLAYWRIGHT',
        error: 'Playwright is not installed in ' + cfg.projectRoot,
        hint: 'Run: npm install -D @playwright/test && npx playwright install',
      });
      process.exit(1);
    }
  }

  let browser = null;
  let openContext = null;
  let actionsDone = [];
  let httpStatus;
  // A recorded HAR is written when its context closes, so close the
  // context before the browser.
  const closeBrowser = async () => {
    if (openContext) await openContext.close().catch(() => undefined);
    await browser.close();
  };
  try {
    const engine = cfg.browser || 'chromium';
    const launchOptions = { headless: true };
    if (cfg.blockPrivate && !cfg.connect) {
      // SSRF guard: every browser connection (each redirect hop and
      // subresource too) goes through this local proxy, which resolves
      // the host itself and refuses blocked ranges before connecting.
      const proxyPort = await startGuardProxy(cfg.blockedRanges || []);
      launchOptions.proxy = { server: 'http://127.0.0.1:' + proxyPort };
      // WebRTC STUN/TURN over UDP does not go through the proxy; keep it off
      // so a page cannot send UDP to (or scan) the private network.
      if (engine === 'firefox') {
        launchOptions.firefoxUserPrefs = { 'network.proxy.allow_hijacking_localhost': true, 'media.peerconnection.enabled': false };
      } else {
        launchOptions.args = ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
      }
    }
    if (cfg.channel) launchOptions.channel = cfg.channel;
    if (cfg.serverlessChromium) {
      launchOptions.executablePath = cfg.serverlessChromium.executablePath;
      launchOptions.args = cfg.serverlessChromium.args.concat(launchOptions.args || []);
    }
    if (cfg.connect) {
      // A remote browser (device cloud, playwright run-server, a Chrome with
      // remote debugging): connect instead of launching.
      browser = cfg.connect.cdp
        ? await pw.chromium.connectOverCDP(cfg.connect.url, { timeout: 30000 })
        : await pw[engine].connect(cfg.connect.url, { timeout: 30000 });
    } else {
      browser = await pw[engine].launch(launchOptions);
    }
    let contextOptions = { viewport: cfg.viewport || { width: 1280, height: 720 } };
    if (cfg.device) {
      const preset = pw.devices && pw.devices[cfg.device];
      if (!preset) {
        const wanted = cfg.device.toLowerCase();
        const near = Object.keys(pw.devices || {}).filter((name) => name.toLowerCase().includes(wanted.split(' ')[0])).slice(0, 5);
        throw new Error('Unknown device preset "' + cfg.device + '"' + (near.length ? '. Close matches: ' + near.join(', ') : ''));
      }
      // The engine stays the caller's choice; the preset brings viewport,
      // user agent, scale and touch. Firefox has no mobile emulation.
      const { defaultBrowserType: _engine, ...emulation } = preset;
      if (engine === 'firefox') delete emulation.isMobile;
      contextOptions = cfg.viewport ? { ...emulation, viewport: cfg.viewport } : emulation;
    }
    if (cfg.mobile) Object.assign(contextOptions, { isMobile: true, hasTouch: true, deviceScaleFactor: 1.75 });
    if (cfg.storageState) contextOptions.storageState = cfg.storageState;
    if (cfg.headers) contextOptions.extraHTTPHeaders = cfg.headers;
    if (cfg.testIdAttribute) pw.selectors.setTestIdAttribute(cfg.testIdAttribute);
    const recording = cfg.har && cfg.har.mode === 'record' && !cfg.snapshotHtmlPath;
    if (recording) contextOptions.recordHar = { path: cfg.har.path, urlFilter: cfg.har.url, mode: 'minimal' };
    const context = await browser.newContext(contextOptions);
    openContext = context;
    // blockWrites: registered first, so it runs last, after the HAR replay
    // and every mock below have had their chance to answer.
    const blockedWrites = { total: 0, requests: [] };
    if (cfg.blockWrites && !cfg.snapshotHtmlPath) {
      await context.route('**/*', (route) => {
        const method = route.request().method();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.fallback();
        blockedWrites.total += 1;
        if (blockedWrites.requests.length < 20) blockedWrites.requests.push({ method: method, url: route.request().url() });
        return route.abort('blockedbyclient');
      });
    }
    // Replay goes first so the network mocks below, registered later, win.
    if (cfg.har && cfg.har.mode === 'replay' && !cfg.snapshotHtmlPath) {
      await context.routeFromHAR(cfg.har.path, { url: cfg.har.url, notFound: cfg.har.notFound || 'abort' });
    }

    // Network mocks. Playwright runs the most recently registered handler
    // first, so register in reverse to make the first listed mock win.
    const routeHits = (cfg.routes || []).map(() => 0);
    if (cfg.routes && cfg.routes.length && !cfg.snapshotHtmlPath) {
      for (let i = cfg.routes.length - 1; i >= 0; i -= 1) {
        const r = cfg.routes[i];
        await context.route(r.url, async (route) => {
          if (r.method && route.request().method() !== r.method) return route.fallback();
          routeHits[i] += 1;
          if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
          if (r.abort) return route.abort('failed');
          if (r.status !== undefined) {
            return route.fulfill({ status: r.status, body: r.body === undefined ? '' : r.body, contentType: r.contentType, headers: r.headers });
          }
          return route.fallback();
        });
      }
    }

    if (cfg.mode === 'perf') await context.addInitScript(perfInit);
    const watchHydration = cfg.mode === 'inspect' && !cfg.snapshotHtmlPath;
    if (watchHydration) await context.addInitScript(hydrationInit);
    let page = await context.newPage();

    // perf: count bytes per request over CDP (cross-origin sizes included)
    // and apply CPU / network throttling before the first byte.
    const requests = new Map();
    if (cfg.mode === 'perf') {
      const cdp = await context.newCDPSession(page);
      cdp.on('Network.responseReceived', (e) => {
        if (requests.size < 2000 || requests.has(e.requestId)) requests.set(e.requestId, Object.assign(requests.get(e.requestId) || {}, { url: e.response.url, type: e.type }));
      });
      cdp.on('Network.loadingFinished', (e) => {
        const r = requests.get(e.requestId);
        if (r) r.bytes = e.encodedDataLength;
      });
      await cdp.send('Network.enable');
      if (cfg.network) {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: cfg.network.latencyMs,
          downloadThroughput: cfg.network.downloadBps,
          uploadThroughput: cfg.network.uploadBps,
        });
      }
      if (cfg.cpuThrottle && cfg.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpuThrottle });
    }

    const consoleMessages = [];
    // Popups and new tabs report their console too.
    const watchConsole = (p) => {
      p.on('console', (msg) => {
        if (consoleMessages.length < 50) consoleMessages.push({ type: msg.type(), text: String(msg.text()).slice(0, 300) });
      });
      p.on('pageerror', (err) => {
        if (consoleMessages.length < 50) consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 300) });
      });
    };
    watchConsole(page);
    context.on('page', watchConsole);

    if (cfg.snapshotHtmlPath) {
      // A DOM snapshot from a trace: render it with every request blocked,
      // so nothing it references is fetched and no script can run.
      await context.route('**/*', (route) => route.abort());
      await page.setContent(require('node:fs').readFileSync(cfg.snapshotHtmlPath, 'utf8'), { waitUntil: 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
    } else {
      const response = await page.goto(cfg.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
      if (response) httpStatus = response.status();
      if (cfg.waitFor) await page.locator(cfg.waitFor).first().waitFor({ state: 'visible', timeout: cfg.waitTimeout || 5000 });
      // perf: let late images, fonts and shifts land before anything else.
      if (cfg.mode === 'perf' && cfg.settleMs) await page.waitForTimeout(cfg.settleMs);
      if (cfg.actions && cfg.actions.length) {
        const ran = await runActions(page, cfg.actions, cfg.actionTimeout || 10000);
        actionsDone = ran.done;
        page = ran.page;
        if (cfg.mode === 'perf') {
          await page.waitForLoadState('load', { timeout: cfg.waitTimeout || 5000 }).catch(() => undefined);
          await page.waitForTimeout(Math.min(cfg.settleMs || 1000, 2000));
        }
      }
    }

    if (cfg.mode === 'login') {
      // Check the session (after logging in, or a saved one), then save it.
      const v = cfg.loginVerify || null;
      let verified = null;
      let verifyNote = '';
      if (v) {
        if (v.url) {
          const resp = await page.goto(v.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
          if (resp) httpStatus = resp.status();
        }
        verified = true;
        if (v.visible) {
          try {
            await resolveChain(page, v.visible).first().waitFor({ state: 'visible', timeout: cfg.waitTimeout || 10000 });
          } catch (waitErr) {
            verified = false;
            verifyNote = 'the signed-in marker did not appear';
          }
        }
        if (verified && v.notUrl && page.url().indexOf(v.notUrl) >= 0) {
          verified = false;
          verifyNote = 'the page went to ' + page.url();
        }
      }
      const state = await context.storageState();
      const now = Date.now() / 1000;
      const expiries = state.cookies.map((c) => c.expires).filter((e) => e > 0);
      // The parent writes the file (inside the project, never through a symlink).
      const keep = !cfg.loginCheckOnly && verified !== false;
      send({
        ok: true,
        data: {
          elementCount: 0,
          matchCount: 0,
          elements: [],
          finalUrl: page.url(),
          title: await page.title(),
          actionsDone: actionsDone,
          routeHits: routeHits,
          blockedWrites: blockedWrites.total ? blockedWrites : undefined,
          httpStatus: httpStatus,
          durationMs: Date.now() - cfg.startedAt,
          login: {
            verified: verified,
            verifyNote: verifyNote,
            state: keep ? state : undefined,
            cookies: state.cookies.length,
            sessionCookies: state.cookies.length - expiries.length,
            origins: state.origins.length,
            firstExpiry: expiries.length ? Math.min.apply(null, expiries) : null,
            expired: expiries.filter((e) => e <= now).length,
          },
        },
      });
      await closeBrowser();
      process.exit(0);
    }

    if (cfg.mode === 'screenshot') {
      if (cfg.selectorChain) {
        await resolveChain(page, cfg.selectorChain).first().screenshot({ path: cfg.screenshotPath });
      } else {
        await page.screenshot({ path: cfg.screenshotPath, fullPage: !!cfg.fullPage });
      }
      send({
        ok: true,
        data: {
          screenshotPath: cfg.screenshotPath,
          title: await page.title(),
          finalUrl: page.url(),
          viewport: page.viewportSize() || { width: 1280, height: 720 },
          tabs: context.pages().length > 1 ? await listTabs(context, page) : undefined,
          elementCount: 0,
          matchCount: 0,
          elements: [],
          actionsDone: actionsDone,
          routeHits: routeHits,
          blockedWrites: blockedWrites.total ? blockedWrites : undefined,
          httpStatus: httpStatus,
          durationMs: Date.now() - cfg.startedAt,
        },
      });
      await closeBrowser();
      process.exit(0);
    }

    await installHelpersEverywhere(page);
    let data;

    if (cfg.mode === 'validate') {
      data = { matchCount: 0, elementCount: 0, elements: [] };
      try {
        const loc = resolveChain(page, cfg.selectorChain);
        data.matchCount = await loc.count();
        data.elementCount = data.matchCount;
        data.elements = await loc.evaluateAll((els) => {
          window.__pwmcp.els = els.slice(0, 5);
          return window.__pwmcp.els.map((el) => window.__pwmcp.describe(el));
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (classifyError(message).kind === 'INVALID_INPUT' || /Unsupported locator/.test(message)) {
          data.parseError = message.split('\n')[0];
        } else {
          throw err;
        }
      }
      if (!data.parseError) {
        // Inside an iframe, suggest locators relative to the frame and keep the frame step in front.
        const parts = splitFrameChain(cfg.selectorChain);
        const scope = parts.frame.length ? resolveChain(page, parts.frame) : page;
        await attachLocators(scope, data.elements, 5, 3);
        if (parts.frame.length) {
          for (const el of data.elements) if (el.locators) el.locators = el.locators.map((chain) => parts.frame.concat(chain));
        }
      }
    } else if (cfg.mode === 'a11y') {
      // axe-core is evaluated in the page itself (not a script tag), so a
      // Content-Security-Policy cannot block it.
      await page.evaluate(require('node:fs').readFileSync(cfg.axeSourcePath, 'utf8'));
      data = await page.evaluate(async (input) => {
        const h = window.__pwmcp;
        const options = { resultTypes: ['violations'] };
        if (input.tags && input.tags.length) options.runOnly = { type: 'tag', values: input.tags };
        let scope = document;
        if (input.selector) {
          scope = document.querySelector(input.selector);
          if (!scope) return { matchCount: 0, elementCount: 0, elements: [], a11y: { violations: [], passes: 0, incomplete: 0, scopeMissing: true }, title: document.title };
        }
        const result = await window.axe.run(scope, options);
        h.els = [];
        const violations = result.violations.map((v) => ({
          id: v.id,
          impact: v.impact || 'minor',
          help: v.help,
          helpUrl: v.helpUrl,
          tags: v.tags,
          nodeCount: v.nodes.length,
          nodes: v.nodes.slice(0, input.maxNodes).map((n) => {
            const target = n.target && n.target.length === 1 && typeof n.target[0] === 'string' ? n.target[0] : undefined;
            let element = -1;
            if (target && h.els.length < 40) {
              try {
                const el = document.querySelector(target);
                if (el) { element = h.els.length; h.els.push(el); }
              } catch (err) { /* selector inside shadow DOM or an iframe */ }
            }
            return {
              target: (n.target || []).map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(' | '),
              html: String(n.html || '').slice(0, 200),
              summary: String(n.failureSummary || '').slice(0, 400),
              element: element,
            };
          }),
        }));
        return {
          matchCount: violations.length,
          elementCount: h.els.length,
          elements: h.els.map((el) => h.describe(el)),
          title: document.title,
          a11y: { violations: violations, passes: result.passes.length, incomplete: result.incomplete.length },
        };
      }, { tags: cfg.axeTags || [], selector: cfg.selector, maxNodes: cfg.maxNodes || 3 });
      await attachLocators(page, data.elements, 40, 2);
    } else if (cfg.mode === 'perf') {
      const collected = await page.evaluate(collectPerf);
      const network = summariseRequests(requests, collected.timings, page.url());
      delete collected.timings;
      Object.assign(collected.perf, network);
      data = Object.assign(collected, { matchCount: 0, elementCount: collected.elements.length });
      await attachLocators(page, data.elements, 12, 2);
    } else if (cfg.mode === 'heal') {
      data = await page.evaluate((input) => {
        const h = window.__pwmcp;
        h.setRoleHint(input.role);
        const scored = [];
        for (const el of Array.prototype.slice.call(document.querySelectorAll('body *'))) {
          if (['script', 'style', 'noscript', 'template', 'svg', 'path'].includes(el.tagName.toLowerCase())) continue;
          const score = h.healScore(el, input.tokens);
          if (score > 0) scored.push({ el: el, score: score });
        }
        scored.sort((a, b) => b.score - a.score);
        // Prefer the innermost element when a parent scores the same.
        const picked = [];
        for (const item of scored) {
          if (picked.length >= 5) break;
          if (picked.some((p) => p.score === item.score && p.el.contains(item.el))) {
            const idx = picked.findIndex((p) => p.score === item.score && p.el.contains(item.el));
            picked[idx] = item;
            continue;
          }
          if (picked.some((p) => item.el.contains(p.el) && p.score >= item.score)) continue;
          picked.push(item);
        }
        h.els = picked.map((p) => p.el);
        const elements = picked.map((p) => Object.assign(h.describe(p.el), { score: p.score }));
        return { matchCount: elements.length, elementCount: document.querySelectorAll('*').length, elements: elements, title: document.title };
      }, { tokens: cfg.healTokens || [], role: cfg.healRole });
      await attachLocators(page, data.elements, 5, 3);
    } else if (cfg.view === 'aria') {
      const scope = cfg.selector ? page.locator(cfg.selector) : page.locator('body');
      const count = await scope.count();
      data = { matchCount: count, elementCount: count, elements: [], title: await page.title(), finalUrl: page.url() };
      if (count > 0) {
        if (typeof scope.ariaSnapshot !== 'function') {
          throw new Error('ariaSnapshot needs Playwright 1.49 or newer');
        }
        const snapshot = await scope.first().ariaSnapshot({ timeout: cfg.waitTimeout || 10000 });
        const max = cfg.maxHtmlChars || 12000;
        data.ariaSnapshot = snapshot.slice(0, max);
        data.ariaTruncated = snapshot.length > max;
      }
      data.viewport = page.viewportSize() || undefined;
    } else {
      data = await page.evaluate((input) => {
        const h = window.__pwmcp;
        const result = { matchCount: 0, elementCount: 0, elements: [], parseError: undefined };
        let source = [];
        if (input.selector) {
          try {
            source = Array.prototype.slice.call(document.querySelectorAll(input.selector));
          } catch (err) {
            result.parseError = err && err.message ? err.message : String(err);
          }
        } else {
          source = Array.prototype.slice.call(document.querySelectorAll('*'));
          if (input.view === 'locators') source = source.filter((el) => h.isMeaningful(el));
        }
        if (result.parseError) return result;

        result.matchCount = source.length;
        result.elementCount = input.selector || input.view === 'locators' ? source.length : document.querySelectorAll('*').length;
        h.els = source.slice(0, input.limit);
        result.elements = h.els.map((el) => h.describe(el));
        result.title = document.title;
        result.finalUrl = location.href;
        result.viewport = { width: window.innerWidth, height: window.innerHeight };
        if (input.includeHtml) {
          const html = document.documentElement.outerHTML;
          result.html = html.slice(0, input.maxHtml);
          result.htmlTruncated = html.length > input.maxHtml;
        }
        return result;
      }, {
        selector: cfg.selector,
        view: cfg.view,
        limit: cfg.view === 'locators' ? 80 : 100,
        includeHtml: !!cfg.includeHtml,
        maxHtml: cfg.maxHtmlChars || 20000,
      });
      if (!data.parseError) {
        // Verify locators for the elements an agent is likely to act on;
        // the full inventory would cost a browser round trip per candidate.
        if (cfg.view === 'locators' || cfg.selector) {
          await attachLocators(page, data.elements, 60, 2);
        } else {
          const meaningful = await page.evaluate(() => window.__pwmcp.els.map((el) => window.__pwmcp.isMeaningful(el)));
          let budget = 30;
          for (let i = 0; i < data.elements.length; i += 1) {
            const el = data.elements[i];
            if (meaningful[i] && budget > 0) {
              budget -= 1;
              el.locators = await verifyCandidates(page, i, el.candidates, 2);
            }
            delete el.candidates;
          }
        }
      }
      // A device preset: report its screen, not the layout width of a page without a viewport meta tag.
      if (cfg.device && page.viewportSize()) data.viewport = page.viewportSize();
    }

    if (watchHydration) {
      // A server-rendered page that has not hydrated yet gets a few seconds.
      await page.waitForFunction(() => { const h = window.__pwmcpHydration; return !h || h.state !== 'pending'; }, null, { timeout: Math.min(cfg.waitTimeout || 5000, 5000), polling: 50 }).catch(() => undefined);
      data.hydration = await page.evaluate(() => {
        const h = window.__pwmcpHydration;
        return h && h.framework ? { framework: h.framework, ssr: h.ssr, state: h.state, firstControlMs: h.firstControlMs, hydratedMs: h.hydratedMs, islands: h.islands } : undefined;
      }).catch(() => undefined);
    }
    data.consoleMessages = consoleMessages;
    data.actionsDone = actionsDone;
    if (context.pages().length > 1) data.tabs = await listTabs(context, page);
    data.routeHits = routeHits;
    if (blockedWrites.total) data.blockedWrites = blockedWrites;
    data.finalUrl = data.finalUrl || page.url();
    data.httpStatus = httpStatus;
    data.durationMs = Date.now() - cfg.startedAt;
    send({ ok: true, data: data });
    await closeBrowser();
    process.exit(0);
  } catch (err) {
    let message = err && err.message ? err.message : String(err);
    // Never echo a remote endpoint: its query string usually holds the access key.
    if (cfg.connect && cfg.connect.url) {
      const u = cfg.connect.url;
      message = message.split(u).join('<remote ' + cfg.connect.host + '>');
      const q = u.indexOf('?');
      if (q > 0) message = message.split(u.slice(q)).join('?<redacted>');
    }
    const classified = classifyError(message);
    if (serverPlaywrightVersion && classified.kind === 'NO_PLAYWRIGHT' && /npx playwright install/.test(classified.hint || '')) {
      // The server's own Playwright needs browsers of its own version.
      classified.hint = 'This project has no Node Playwright, so the server uses its own (' + serverPlaywrightVersion + '). Install its browser once: npx -y playwright@' + serverPlaywrightVersion + ' install chromium';
    }
    const extra = (err && err.pageUrl ? '\nPage URL at failure: ' + err.pageUrl : '') + (err && err.callLog ? '\nCall log:\n' + err.callLog : '');
    send({ ok: false, kind: classified.kind, error: message + extra, hint: classified.hint, actionsDone: err && err.actionsDone });
    try { if (browser) await closeBrowser(); } catch (closeErr) { /* ignore */ }
    process.exit(1);
  }
})().catch((err) => {
  send({ ok: false, kind: 'UNKNOWN', error: err && err.message ? err.message : String(err) });
  process.exit(1);
});
`;
