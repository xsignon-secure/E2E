/**
 * OAuth Client ID Metadata Documents (CIMD), the way MCP clients identify
 * themselves since the 2025-11-25 spec (dynamic client registration is now
 * the deprecated fallback).
 *
 * The client's `client_id` is an https URL. The authorization server
 * fetches it and gets a small JSON document that names the client and
 * lists the redirect URIs it may use; the document's own `client_id` must
 * equal the URL. Nothing is registered or stored, which suits this
 * stateless, serverless bridge.
 *
 * Fetching a URL a stranger chose is a server-side request, so the fetch is
 * fenced: https only, no redirects, private and reserved addresses refused
 * (always, not only when PW_MCP_BLOCK_PRIVATE_URLS is on), a short timeout
 * and a small size cap. Good documents are cached briefly per URL.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress } from './url-policy.js';

/** The spec suggests documents stay under 5 KB; allow some slack. */
export const MAX_METADATA_BYTES = 16 * 1024;
export const METADATA_TIMEOUT_MS = 5_000;
const MAX_CLIENT_ID_LENGTH = 2_000;
const DEFAULT_CACHE_SECONDS = 5 * 60;
const MAX_CACHE_SECONDS = 60 * 60;
const MAX_CACHE_ENTRIES = 200;

export interface ClientMetadata {
  clientId: string;
  redirectUris: string[];
  name: string;
}

export interface ClientMetadataFetcherOptions {
  /** fetch implementation; tests pass a fake. */
  fetch?: typeof fetch;
  /** Host name to IP addresses; tests pass a fake. */
  resolve?: (host: string) => Promise<string[]>;
  /** Accepts a redirect URI (scheme rules and the operator's host allowlist). */
  redirectAllowed: (uri: unknown) => uri is string;
  /** Clock in seconds. */
  now?: () => number;
}

export class ClientMetadataError extends Error {}

/**
 * True when `value` is shaped like a metadata document URL: https, a path
 * beyond `/`, and no fragment, credentials or dot segments.
 */
export function isClientMetadataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_CLIENT_ID_LENGTH || !value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#')) return false;
  if (url.pathname === '/' || url.pathname === '') return false;
  // Dot segments are normalized away by URL; refuse any in the raw string.
  const rawPath = value.slice(value.indexOf('/', 'https://'.length)).split(/[?]/)[0];
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..' || /^%2e/i.test(segment))) return false;
  // The document's client_id must equal the URL byte for byte, so only
  // accept URLs that are already in their normal form.
  return url.href === value;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** max-age from Cache-Control, capped; the default when absent. */
function cacheSeconds(header: string | null): number {
  if (header && /no-store|no-cache/i.test(header)) return 0;
  const match = /max-age=(\d+)/i.exec(header ?? '');
  if (!match) return DEFAULT_CACHE_SECONDS;
  return Math.min(Number(match[1]), MAX_CACHE_SECONDS);
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw new ClientMetadataError('the client metadata document is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ClientMetadataError('the client metadata document is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Check a parsed document against the URL it came from. */
export function validateClientMetadata(
  clientId: string,
  document: unknown,
  redirectAllowed: (uri: unknown) => uri is string,
): ClientMetadata {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ClientMetadataError('the client metadata document is not a JSON object');
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) throw new ClientMetadataError('the document\'s client_id does not match its URL');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    throw new ClientMetadataError('the document must list 1 to 10 redirect_uris');
  }
  if (!uris.every(redirectAllowed)) {
    throw new ClientMetadataError('a redirect URI is not allowed (https, or http on localhost, on an allowed host)');
  }
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    // Secrets can't live in a public document; key-based client auth is not supported here.
    throw new ClientMetadataError('only public clients (token_endpoint_auth_method "none") are supported');
  }
  const grants = doc.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code'))) {
    throw new ClientMetadataError('the client must use the authorization_code grant');
  }
  const name = typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : '';
  return { clientId, redirectUris: uris as string[], name };
}

export type ClientMetadataFetcher = (clientId: string) => Promise<ClientMetadata>;

/** A fetcher with a small per-instance cache of good documents. */
export function createClientMetadataFetcher(options: ClientMetadataFetcherOptions): ClientMetadataFetcher {
  const doFetch = options.fetch ?? fetch;
  const resolve = options.resolve ?? defaultResolve;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = new Map<string, { metadata: ClientMetadata; expires: number }>();

  return async (clientId) => {
    if (!isClientMetadataUrl(clientId)) throw new ClientMetadataError('the client_id is not a valid metadata document URL');
    const cached = cache.get(clientId);
    if (cached && cached.expires > now()) return cached.metadata;
    cache.delete(clientId);

    const host = new URL(clientId).hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await resolve(host);
    } catch {
      throw new ClientMetadataError(`could not resolve ${host}`);
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new ClientMetadataError(`${host} points at a private or reserved address`);
    }

    let response: Response;
    try {
      response = await doFetch(clientId, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch {
      throw new ClientMetadataError('could not fetch the client metadata document');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new ClientMetadataError(`fetching the client metadata document returned HTTP ${response.status}`);
    }
    const text = await readCapped(response, MAX_METADATA_BYTES);
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new ClientMetadataError('the client metadata document is not valid JSON');
    }
    const metadata = validateClientMetadata(clientId, document, options.redirectAllowed);
    const ttl = cacheSeconds(response.headers.get('cache-control'));
    if (ttl > 0) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(clientId, { metadata, expires: now() + ttl });
    }
    return metadata;
  };
}
