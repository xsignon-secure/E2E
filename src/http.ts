/**
 * Streamable HTTP bridge for the MCP server.
 *
 * `createMcpHandler` (MCP SDK) is fetch-shaped: it answers the 2025
 * streamable-HTTP transport *statelessly* — a fresh server per request, which
 * is exactly what a serverless function wants — and the modern envelope
 * transport on the same URL. This module adds the thin adapter for runtimes
 * that hand you Node's `IncomingMessage`/`ServerResponse` pair (Vercel
 * functions, a plain `node:http` server), so the very same code path can be
 * verified locally before it is deployed.
 *
 * The stdio transport in server.ts is untouched; this is an additional way to
 * reach the same nineteen tools.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, hostHeaderValidationResponse } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createOAuthServer, originOf } from './oauth.js';
import {
  AI_CATALOG_MEDIA_TYPE,
  DISCOVERY_CORS_HEADERS,
  SERVER_CARD_MEDIA_TYPE,
  buildAiCatalog,
  buildServerCard,
} from './discovery.js';
import { clientAddress, createAttemptLimiter } from './utils/attempt-limiter.js';
import { createServer, READ_ONLY_TOOLS, SERVER_VERSION, supportedProtocolVersions } from './server.js';
import { setMaxChildren, setScrubChildEnv } from './utils/playwright-runner.js';
import { setBlockPrivateUrls } from './utils/url-policy.js';
import { logger } from './utils/logger.js';

/** Mirrors the SDK's default POST body bound, so oversized bodies die early. */
export { provideServerlessChromium } from './utils/serverless-chromium.js';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpHttpHandlerOptions {
  /**
   * Bearer token clients must send (`Authorization: Bearer <token>`).
   * Defaults to PW_MCP_HTTP_TOKEN. With a token every tool is served;
   * without one only READ_ONLY_TOOLS are, in restricted mode, so an open
   * endpoint can never spawn processes, drive a browser or write files.
   */
  token?: string;
  /**
   * Hostnames accepted in the Host header (DNS-rebinding protection).
   * Defaults to PW_MCP_ALLOWED_HOSTS (comma separated; `*` allows any).
   * When unset and there is no token, only localhost names and the
   * deployment's own Vercel hostnames are accepted.
   */
  allowedHosts?: string[];
  /**
   * Path the MCP endpoint is served on, advertised as the OAuth protected
   * resource. Defaults to `/api/mcp`, where the Vercel function lives.
   */
  mcpPath?: string;
  /**
   * Wrong tokens or access keys one client may send in 15 minutes before it
   * is refused with 429. Defaults to PW_MCP_MAX_FAILED_AUTH, else 20.
   */
  maxFailedAuth?: number;
  /**
   * Hosts OAuth apps may return users to. Defaults to
   * PW_MCP_OAUTH_REDIRECT_HOSTS (comma separated; `.example.com` covers its
   * subdomains). Empty allows any https host; localhost is always allowed.
   */
  redirectHosts?: string[];
}

/** Tokens shorter than this are refused: they can be guessed. */
export const MIN_TOKEN_LENGTH = 16;

/** Tokens shorter than this still work, with a warning to use a longer one. */
export const RECOMMENDED_TOKEN_LENGTH = 32;

/** Window for counting failed sign-ins, in seconds. */
const FAILED_AUTH_WINDOW = 15 * 60;

/** Default Host allowlist for an open (token-less) bridge. */
function defaultAllowedHosts(): string[] {
  const vercel = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .map((host) => host?.trim().toLowerCase())
    .filter((host): host is string => Boolean(host));
  return ['localhost', '127.0.0.1', '[::1]', ...vercel];
}

function envList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Constant-time comparison of the presented bearer token (hashed, so length does not leak). */
function tokenMatches(header: string | null, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  if (!match) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

/** A positive integer from the environment, or the fallback. */
function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Public discovery documents (Server Card extension, SEP-2127): the card at
 * `<mcp-url>/server-card` and the AI Catalog at
 * `/.well-known/ai-catalog.json`. They hold only public metadata (no tools,
 * no secrets), so they are served before authentication, with open CORS.
 * Vercel rewrites both paths to the function with `mcp_route` set.
 * Returns undefined for every other request.
 */
export function discoveryResponse(request: Request, mcpPath: string, tokenProtected: boolean): Response | undefined {
  const url = new URL(request.url);
  const routed = url.searchParams.get('mcp_route');
  const isCard = routed === 'server-card' || url.pathname.endsWith('/server-card');
  const isCatalog = routed === 'ai-catalog' || url.pathname === '/.well-known/ai-catalog.json';
  if (!isCard && !isCatalog) return undefined;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: DISCOVERY_CORS_HEADERS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(405, { error: 'method not allowed' }, { ...DISCOVERY_CORS_HEADERS, allow: 'GET, HEAD, OPTIONS' });
  }
  const origin = originOf(request);
  // A direct `<path>/server-card` names its own endpoint; the rewritten form
  // and the catalog use the configured MCP path.
  const endpointPath = isCard && !routed ? url.pathname.slice(0, -'/server-card'.length) || '/' : mcpPath;
  const body = isCard
    ? buildServerCard({
        endpoint: `${origin}${endpointPath}`,
        version: SERVER_VERSION,
        tokenProtected,
        protocolVersions: supportedProtocolVersions(),
      })
    : buildAiCatalog(`${origin}${mcpPath}/server-card`, new URL(origin).hostname);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': isCard ? SERVER_CARD_MEDIA_TYPE : AI_CATALOG_MEDIA_TYPE,
      'cache-control': 'public, max-age=3600',
      ...DISCOVERY_CORS_HEADERS,
    },
  });
}

/** Build the fetch-shaped MCP handler backed by a fresh server per request. */
export function createMcpHttpHandler(options: McpHttpHandlerOptions = {}): McpHttpHandler {
  const token = (options.token ?? process.env.PW_MCP_HTTP_TOKEN ?? '').trim();
  if (token && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`PW_MCP_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (use a random value).`);
  }
  const configuredHosts = options.allowedHosts ?? envList(process.env.PW_MCP_ALLOWED_HOSTS);
  const allowedHosts = configuredHosts.includes('*')
    ? []
    : configuredHosts.length > 0 || token
      ? configuredHosts
      : defaultAllowedHosts();
  // Children spawned on behalf of HTTP callers must not see deployment
  // secrets, and URL tools must not reach the deployment's private network.
  setScrubChildEnv(true);
  setMaxChildren(positiveIntFromEnv(process.env.PW_MCP_MAX_CHILDREN, 4));
  setBlockPrivateUrls(true);
  if (!token) {
    logger.warn('PW_MCP_HTTP_TOKEN is not set; serving read-only tools only', { tools: READ_ONLY_TOOLS });
  } else if (token.length < RECOMMENDED_TOKEN_LENGTH) {
    logger.warn(`PW_MCP_HTTP_TOKEN is shorter than ${RECOMMENDED_TOKEN_LENGTH} characters; use a longer random value`);
  }
  const limiter = createAttemptLimiter({
    max: options.maxFailedAuth ?? positiveIntFromEnv(process.env.PW_MCP_MAX_FAILED_AUTH, 20),
    windowSeconds: FAILED_AUTH_WINDOW,
  });
  // With a token, OAuth clients (claude.ai connectors) sign in by typing it
  // on the authorize page; without one the endpoint is open and needs none.
  const mcpPath = options.mcpPath ?? '/api/mcp';
  const oauth = token
    ? createOAuthServer({
        token,
        mcpPath,
        limiter,
        redirectHosts: options.redirectHosts ?? envList(process.env.PW_MCP_OAUTH_REDIRECT_HOSTS),
      })
    : undefined;
  const inner = createMcpHandler(
    (context) =>
      createServer({
        ...(token ? {} : { tools: READ_ONLY_TOOLS, restricted: true }),
        // Lets tools stop their children when the HTTP client disconnects.
        requestSignal: context?.requestInfo?.signal,
      }),
    {
      legacy: 'stateless',
      onerror: (error: Error) => logger.error('mcp http handler error', { error }),
    },
  );
  return {
    ...inner,
    fetch: async (request, requestOptions) => {
      if (allowedHosts.length > 0) {
        const rejected = hostHeaderValidationResponse(request, allowedHosts);
        if (rejected) return rejected;
      }
      const discovery = discoveryResponse(request, mcpPath, Boolean(token));
      if (discovery) return discovery;
      if (oauth) {
        const oauthResponse = await oauth.handle(request);
        if (oauthResponse) return oauthResponse;
        const caller = clientAddress(request);
        const wait = limiter.retryAfter(caller);
        if (wait > 0) {
          return jsonResponse(429, { error: 'too many failed sign-ins; try again later' }, { 'retry-after': String(wait) });
        }
        const authorization = request.headers.get('authorization');
        if (!tokenMatches(authorization, token) && !oauth.verifyAccessToken(authorization)) {
          // A request with no credentials is a client discovering OAuth, not a guess.
          if (authorization) limiter.fail(caller);
          return jsonResponse(401, { error: 'unauthorized' }, { 'www-authenticate': oauth.challenge(request) });
        }
      }
      return inner.fetch(request, requestOptions);
    },
  };
}

/** A failure that maps onto an HTTP status before any response is written. */
class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Stop reading; the caller answers 413 and then closes the connection.
      req.pause();
      throw new RequestError(413, 'request body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

function buildRequest(req: IncomingMessage, method: string, body: Buffer | undefined, signal: AbortSignal): Request {
  const protocol = (firstHeader(req.headers['x-forwarded-proto']) ?? 'http').split(',')[0].trim();
  const host = firstHeader(req.headers.host) ?? 'localhost';
  const headers = toHeaders(req.headers);
  // Vercel sets x-real-ip itself, and PW_MCP_TRUST_PROXY=1 says a reverse
  // proxy in front does. Otherwise a caller could forge it, so the socket's
  // address replaces it before the sign-in limiter reads it.
  if (!process.env.VERCEL && process.env.PW_MCP_TRUST_PROXY !== '1') {
    headers.delete('x-forwarded-for');
    headers.set('x-real-ip', req.socket?.remoteAddress ?? 'unknown');
  }
  const init: RequestInit = { method, headers, signal };
  if (body && body.byteLength > 0) init.body = body;
  return new Request(`${protocol}://${host}${req.url ?? '/'}`, init);
}

/** Resolve when the socket drains or closes, so a dead client cannot hang us. */
function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * Serve one Node request through the MCP handler.
 *
 * Always settles: a transport failure becomes a JSON error response, and a
 * mid-stream failure closes the socket so the client stops waiting.
 */
export async function handleNodeRequest(
  handler: McpHttpHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Abort the request (and the tool's children) when the client goes away
  // before the response is complete, so its child slot is freed at once.
  const disconnect = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) disconnect.abort();
  });
  let response: Response;
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    response = await handler.fetch(buildRequest(req, method, body, disconnect.signal));
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    if (status !== 413 && !(err instanceof RequestError)) {
      logger.error('mcp http request failed', { error: err });
    }
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      // Only our own RequestError messages are meant for clients; anything
      // else may carry paths or internals, so it stays in the server log.
      const message = err instanceof RequestError ? err.message : 'internal server error';
      if (status === 413) res.setHeader('connection', 'close');
      res.end(JSON.stringify({ error: message }), () => {
        if (status === 413) req.destroy();
      });
    } else if (!res.writableEnded) {
      res.destroy();
    }
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Let Node choose chunked framing for streamed bodies.
    if (key.toLowerCase() === 'content-length' && response.body) return;
    res.setHeader(key, value);
  });

  const body = response.body;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  try {
    for (;;) {
      if (res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0 && !res.write(Buffer.from(value))) {
        await waitDrain(res);
      }
    }
  } catch (err) {
    logger.warn('mcp http response stream failed', { error: err });
    if (!res.writableEnded) res.destroy();
    return;
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!res.writableEnded) res.end();
}
