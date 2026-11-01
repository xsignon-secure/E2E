/**
 * Who this server is and how clients find it, for the 2026-07-28 MCP
 * revision and its official extensions:
 *
 * - `SERVER_IDENTITY`: the `serverInfo` every result and `server/discover`
 *   carry (title, description, website, icons), so clients can show the
 *   server properly instead of a bare package name.
 * - `CACHE_HINTS`: `ttlMs` / `cacheScope` for the cacheable list results
 *   (SEP-2549). The tool, prompt and resource lists only change when the
 *   package is upgraded or restarted with other options, so clients may
 *   keep them for an hour instead of asking again on every turn.
 * - `buildServerCard` / `buildAiCatalog`: the Server Card extension
 *   (SEP-2127) for the HTTP bridge, served at `<mcp-url>/server-card` and
 *   linked from `/.well-known/ai-catalog.json`, so registries and IDEs can
 *   discover and configure the hosted endpoint before connecting.
 *
 * The values here must agree with server.json (the MCP Registry entry) and
 * with what `server/discover` returns; a test checks both.
 */

import type { CacheHint } from '@modelcontextprotocol/server';

/** The MCP Registry name (package.json `mcpName`, server.json `name`). */
export const REGISTRY_NAME = 'io.github.xsignon-secure/E2E';

export const REPOSITORY_URL = 'https://github.com/xsignon-secure/E2E';

/** Display metadata shared by serverInfo, the Server Card and server.json. */
export const SERVER_IDENTITY = {
  title: 'Playwright E2E MCP',
  /** At most 100 characters: the Server Card and registry limit. */
  description: 'Diagnose and fix Playwright tests (TS, pytest): CI reports, traces, verified fixes, flaky verdicts.',
  websiteUrl: `${REPOSITORY_URL}#readme`,
  icons: [
    {
      src: 'https://raw.githubusercontent.com/xsignon-secure/E2E/main/docs/logo.png',
      mimeType: 'image/png',
      sizes: ['400x400'],
    },
  ],
} as const;

/** One hour: list results only change on an upgrade or a restart. */
export const LIST_TTL_MS = 60 * 60 * 1000;

/**
 * Cache hints for the cacheable results. `private` because the bridge serves
 * a different tool list with and without a token, so a shared cache must not
 * hand one caller's list to another.
 */
export const CACHE_HINTS: Record<
  'tools/list' | 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'server/discover',
  CacheHint
> = {
  'tools/list': { ttlMs: LIST_TTL_MS, cacheScope: 'private' },
  'prompts/list': { ttlMs: LIST_TTL_MS, cacheScope: 'private' },
  'resources/list': { ttlMs: LIST_TTL_MS, cacheScope: 'private' },
  'resources/templates/list': { ttlMs: LIST_TTL_MS, cacheScope: 'private' },
  'server/discover': { ttlMs: LIST_TTL_MS, cacheScope: 'private' },
};

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';

export interface ServerCardOptions {
  /** Absolute URL of the streamable-HTTP endpoint, e.g. https://host/api/mcp. */
  endpoint: string;
  version: string;
  /** Whether the endpoint wants `Authorization: Bearer <token>` for the full tool set. */
  tokenProtected: boolean;
  /** The protocol versions the endpoint serves (what server/discover reports). */
  protocolVersions: string[];
}

/** The Server Card (SEP-2127) for one hosted endpoint. Public metadata only. */
export function buildServerCard(options: ServerCardOptions): Record<string, unknown> {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: REGISTRY_NAME,
    version: options.version,
    description: SERVER_IDENTITY.description,
    title: SERVER_IDENTITY.title,
    websiteUrl: SERVER_IDENTITY.websiteUrl,
    repository: { url: REPOSITORY_URL, source: 'github' },
    icons: SERVER_IDENTITY.icons,
    remotes: [
      {
        type: 'streamable-http',
        url: options.endpoint,
        ...(options.tokenProtected
          ? {
              headers: [
                {
                  name: 'Authorization',
                  description: 'Bearer token for this deployment (or sign in with OAuth when the client supports it).',
                  isRequired: true,
                  isSecret: true,
                  value: 'Bearer {token}',
                  variables: { token: { description: 'The deployment token (PW_MCP_HTTP_TOKEN)', isRequired: true, isSecret: true } },
                },
              ],
            }
          : {}),
        supportedProtocolVersions: [...options.protocolVersions],
      },
    ],
  };
}

/** The AI Catalog (`/.well-known/ai-catalog.json`) pointing at the card. */
export function buildAiCatalog(cardUrl: string, host: string): Record<string, unknown> {
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:air:${host}:mcp:playwright-e2e-mcp`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: cardUrl,
      },
    ],
  };
}

/** CORS headers the Server Card discovery spec requires on both documents. */
export const DISCOVERY_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
};
