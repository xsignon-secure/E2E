/**
 * OAuth 2.1 sign-in for the token-protected HTTP bridge.
 *
 * Clients such as claude.ai custom connectors cannot send a fixed bearer
 * token; they discover an authorization server (RFC 9728 / RFC 8414),
 * register themselves (RFC 7591) and run the authorization-code flow with
 * PKCE. This module is that authorization server, kept stateless so it fits a
 * serverless function: client ids, codes and tokens are HMAC-signed payloads
 * keyed from PW_MCP_HTTP_TOKEN, so nothing is stored and rotating the token
 * signs every client out.
 *
 * Signing in means typing the access key (PW_MCP_HTTP_TOKEN) on the
 * authorize page, so OAuth grants exactly the access the bearer token
 * already grants and nothing more.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { clientAddress } from './utils/attempt-limiter.js';
import type { AttemptLimiter } from './utils/attempt-limiter.js';

/** Lifetimes, in seconds. */
const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;

type TokenType = 'client' | 'code' | 'access' | 'refresh';

interface Payload {
  typ: TokenType;
  exp?: number;
  [key: string]: unknown;
}

export interface OAuthOptions {
  /** The bridge's bearer token: the access key users type, and the signing secret. */
  token: string;
  /** Path the MCP endpoint is served on, used as the protected resource. */
  mcpPath: string;
  /** Clock in seconds; tests override it. */
  now?: () => number;
  /** Counts wrong access keys typed on the authorize page, per client address. */
  limiter?: AttemptLimiter;
  /**
   * Hostnames a registered app may send users back to (exact match, or
   * `.example.com` for its subdomains). Empty allows any https host.
   */
  redirectHosts?: string[];
}

export interface OAuthServer {
  /** Answer an OAuth or discovery request, or return undefined for anything else. */
  handle(request: Request): Promise<Response | undefined>;
  /** True when the Authorization header carries a valid OAuth access token. */
  verifyAccessToken(header: string | null): boolean;
  /** WWW-Authenticate value for a 401 on the MCP endpoint. */
  challenge(request: Request): string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Origin as the client saw it (Vercel terminates TLS and forwards the scheme). */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return `${proto || url.protocol.replace(/:$/, '')}://${url.host}`;
}

/**
 * The route an OAuth request is for. Vercel rewrites these paths to the one
 * function and passes the original path as `oauth_route`, so both the
 * rewritten and the direct form resolve to the same route.
 */
function routeOf(url: URL): string {
  const routed = url.searchParams.get('oauth_route');
  if (routed && (routed.startsWith('/.well-known/oauth-') || routed.startsWith('/oauth/'))) return routed;
  return url.pathname;
}

/** https anywhere, or http on a loopback host (native and CLI clients). */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** True when `value`'s host is in the allowlist (empty allows every host). */
export function isAllowedRedirectHost(value: string, hosts: string[]): boolean {
  if (hosts.length === 0) return true;
  const host = new URL(value).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  return hosts.some((allowed) => {
    const entry = allowed.trim().toLowerCase();
    return entry.startsWith('.') ? host.endsWith(entry) : host === entry;
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...headers },
  });
}

function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

async function readParams(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

export function createOAuthServer(options: OAuthOptions): OAuthServer {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const key = createHmac('sha256', options.token).update('playwright-e2e-mcp oauth v1').digest();
  const redirectHosts = options.redirectHosts ?? [];
  const redirectAllowed = (uri: unknown): uri is string => isAllowedRedirectUri(uri) && isAllowedRedirectHost(uri, redirectHosts);

  function sign(payload: Payload): string {
    const body = base64url(JSON.stringify(payload));
    const mac = base64url(createHmac('sha256', key).update(body).digest());
    return `${body}.${mac}`;
  }

  function verify(value: string | null | undefined, typ: TokenType): Payload | undefined {
    if (!value) return undefined;
    const [body, mac, extra] = value.split('.');
    if (!body || !mac || extra !== undefined) return undefined;
    const expected = base64url(createHmac('sha256', key).update(body).digest());
    if (!safeEqual(mac, expected)) return undefined;
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    } catch {
      return undefined;
    }
    if (payload.typ !== typ) return undefined;
    if (payload.exp !== undefined && payload.exp <= now()) return undefined;
    return payload;
  }

  /** Short, stable binding of a code or token to the client that asked for it. */
  function clientTag(clientId: string): string {
    return base64url(sha256(clientId)).slice(0, 22);
  }

  function client(clientId: string | null): { redirectUris: string[]; name: string } | undefined {
    const payload = verify(clientId, 'client');
    if (!payload || !Array.isArray(payload.r)) return undefined;
    return { redirectUris: payload.r.filter(redirectAllowed), name: typeof payload.n === 'string' ? payload.n : '' };
  }

  function issueTokens(tag: string): Response {
    const issued = now();
    return json(200, {
      access_token: sign({ typ: 'access', c: tag, exp: issued + ACCESS_TTL }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: sign({ typ: 'refresh', c: tag, exp: issued + REFRESH_TTL }),
      scope: 'mcp',
    });
  }

  function resourceMetadata(request: Request, suffix: string): Response {
    const origin = originOf(request);
    return json(200, {
      resource: `${origin}${suffix || options.mcpPath}`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      resource_name: 'playwright-e2e-mcp',
    });
  }

  function serverMetadata(request: Request): Response {
    const origin = originOf(request);
    return json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  }

  async function register(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await request.text()) as Record<string, unknown>;
    } catch {
      return oauthError(400, 'invalid_client_metadata', 'Body must be JSON.');
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(isAllowedRedirectUri)) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be https URLs, or http on localhost.');
    }
    if (!uris.every((uri) => isAllowedRedirectHost(uri, redirectHosts))) {
      return oauthError(400, 'invalid_redirect_uri', 'This server only accepts apps that return to the hosts it allows.');
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : '';
    const issuedAt = now();
    return json(201, {
      client_id: sign({ typ: 'client', r: uris, n: name, iat: issuedAt }),
      client_id_issued_at: issuedAt,
      client_name: name || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  function page(status: number, title: string, inner: string): Response {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --text:#0f172a; --muted:#475569; --accent:#4c1d95; --border:#e2e8f0; --error:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1020; --card:#131a2e; --text:#e2e8f0; --muted:#94a3b8; --accent:#a78bfa; --border:#273149; --error:#f87171; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, sans-serif; padding:16px; box-sizing:border-box; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--muted); margin:0 0 16px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input[type=password] { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid var(--border); border-radius:10px; font:inherit; background:transparent; color:inherit; }
  button { margin-top:16px; width:100%; padding:11px; border:0; border-radius:10px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  .error { color:var(--error); font-weight:600; }
  code { word-break:break-all; }
</style></head><body><main>${inner}</main></body></html>`;
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      },
    });
  }

  function redirectWith(redirectUri: string, params: Record<string, string>): Response {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
    return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
  }

  async function authorize(request: Request): Promise<Response> {
    const isPost = request.method === 'POST';
    const params = isPost ? await readParams(request) : new URL(request.url).searchParams;
    const clientId = params.get('client_id');
    const registered = client(clientId);
    if (!clientId || !registered) {
      return page(400, 'Sign-in failed', '<h1>Unknown client</h1><p>This app is not registered with the server. Try connecting again.</p>');
    }
    const redirectUri = params.get('redirect_uri') ?? (registered.redirectUris.length === 1 ? registered.redirectUris[0] : '');
    if (!registered.redirectUris.includes(redirectUri)) {
      return page(400, 'Sign-in failed', '<h1>Invalid redirect</h1><p>The return address does not match the registered app.</p>');
    }
    const state = params.get('state') ?? '';
    const withState = (extra: Record<string, string>): Record<string, string> => (state ? { ...extra, state } : extra);
    if (params.get('response_type') !== 'code') {
      return redirectWith(redirectUri, withState({ error: 'unsupported_response_type' }));
    }
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return redirectWith(redirectUri, withState({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' }));
    }

    const caller = clientAddress(request);
    const wait = isPost ? (options.limiter?.retryAfter(caller) ?? 0) : 0;
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      const response = page(
        429,
        'Too many attempts',
        `<h1>Too many attempts</h1><p>Too many wrong access keys were entered. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.</p>`,
      );
      response.headers.set('retry-after', String(wait));
      return response;
    }
    const accessKey = isPost ? (params.get('access_key') ?? '') : '';
    if (isPost && accessKey && safeEqual(accessKey.trim(), options.token)) {
      const code = sign({ typ: 'code', c: clientTag(clientId), r: redirectUri, cc: challenge, exp: now() + CODE_TTL });
      return redirectWith(redirectUri, withState({ code, iss: originOf(request) }));
    }
    if (isPost) options.limiter?.fail(caller);

    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .map((name) => [name, name === 'redirect_uri' ? redirectUri : params.get(name)] as const)
      .filter(([, value]) => value)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value as string)}">`)
      .join('');
    const appName = registered.name ? `<strong>${escapeHtml(registered.name)}</strong>` : 'An app';
    const host = new URL(redirectUri).host;
    const error = isPost ? '<p class="error">That access key is not right. Try again.</p>' : '';
    return page(
      isPost ? 401 : 200,
      'Sign in to playwright-e2e-mcp',
      `<h1>Sign in to playwright-e2e-mcp</h1>
<p>${appName} at <code>${escapeHtml(host)}</code> wants to use this server's Playwright tools. Enter the server's access key to allow it.</p>
${error}<form method="post" action="/oauth/authorize">${hidden}
<label for="access_key">Access key</label>
<input id="access_key" name="access_key" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Allow access</button>
</form>`,
    );
  }

  async function tokenEndpoint(request: Request): Promise<Response> {
    const params = await readParams(request);
    const clientId = params.get('client_id');
    if (clientId && !client(clientId)) return oauthError(401, 'invalid_client', 'Unknown client.');
    switch (params.get('grant_type')) {
      case 'authorization_code': {
        const code = verify(params.get('code'), 'code');
        if (!code || !clientId || code.c !== clientTag(clientId)) {
          return oauthError(400, 'invalid_grant', 'The code is invalid or expired.');
        }
        if (params.get('redirect_uri') !== code.r) {
          return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
        }
        const verifier = params.get('code_verifier') ?? '';
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(base64url(sha256(verifier)), String(code.cc))) {
          return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
        }
        return issueTokens(String(code.c));
      }
      case 'refresh_token': {
        const refresh = verify(params.get('refresh_token'), 'refresh');
        if (!refresh || (clientId && refresh.c !== clientTag(clientId))) {
          return oauthError(400, 'invalid_grant', 'The refresh token is invalid or expired.');
        }
        return issueTokens(String(refresh.c));
      }
      default:
        return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
  }

  return {
    async handle(request) {
      const url = new URL(request.url);
      const route = routeOf(url);
      const isOAuthRoute = route.startsWith('/.well-known/oauth-') || route.startsWith('/oauth/');
      if (!isOAuthRoute) return undefined;
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      const protectedPrefix = '/.well-known/oauth-protected-resource';
      if (route === protectedPrefix || route.startsWith(`${protectedPrefix}/`)) {
        return request.method === 'GET' ? resourceMetadata(request, route.slice(protectedPrefix.length)) : oauthError(405, 'invalid_request', 'Use GET.');
      }
      if (route === '/.well-known/oauth-authorization-server' || route.startsWith('/.well-known/oauth-authorization-server/')) {
        return request.method === 'GET' ? serverMetadata(request) : oauthError(405, 'invalid_request', 'Use GET.');
      }
      if (route === '/oauth/register') {
        return request.method === 'POST' ? register(request) : oauthError(405, 'invalid_request', 'Use POST.');
      }
      if (route === '/oauth/authorize') {
        return request.method === 'GET' || request.method === 'POST' ? authorize(request) : oauthError(405, 'invalid_request', 'Use GET or POST.');
      }
      if (route === '/oauth/token') {
        return request.method === 'POST' ? tokenEndpoint(request) : oauthError(405, 'invalid_request', 'Use POST.');
      }
      return oauthError(404, 'invalid_request', 'Unknown OAuth endpoint.');
    },

    verifyAccessToken(header) {
      const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
      return Boolean(match && verify(match[1].trim(), 'access'));
    },

    challenge(request) {
      const origin = originOf(request);
      const path = new URL(request.url).pathname;
      const suffix = path === '/' ? '' : path;
      return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${suffix}", scope="mcp"`;
    },
  };
}
