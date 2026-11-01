/**
 * MCP server setup: creates the McpServer instance, registers the nineteen
 * tools (with spec tool annotations) and the workflow prompts, and wires
 * each invocation to a ToolContext (per-tool logger, abort signal, progress
 * reporter, shared store, default project root).
 *
 * Logs go to stderr only — stdout belongs to the MCP protocol.
 */

import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';
import type { RegisteredTool, ServerContext, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withCompactJsonSchema } from './utils/compact-schema.js';
import type { ToolContext, ToolResponse, ToolStore } from './types/index.js';
import { toPlaywrightMcpError } from './types/index.js';
import { logger } from './utils/logger.js';
import { killActiveChildren } from './utils/playwright-runner.js';
import { ConfirmationPending, createConfirmWrite } from './utils/confirm.js';
import { createToolStore, toolError } from './tools/shared.js';
import { appMetaFor, registerApps } from './apps/index.js';
import { runTestTool } from './tools/run-test.js';
import { getFailureTool } from './tools/get-failure.js';
import { inspectPageTool } from './tools/inspect-page.js';
import { listTestsTool } from './tools/list-tests.js';
import { validateSelectorTool } from './tools/validate-selector.js';
import { auditAccessibilityTool } from './tools/audit-accessibility.js';
import { auditPerformanceTool } from './tools/audit-performance.js';
import { generateE2ETestTool } from './tools/generate-e2e-test.js';
import { compareVisualStateTool } from './tools/compare-visual-state.js';
import { diagnoseFlakyTool } from './tools/diagnose-flaky.js';
import { suggestFixTool } from './tools/suggest-fix.js';
import { analyzeHistoryTool } from './tools/analyze-history.js';
import { getRunStatusTool } from './tools/get-run-status.js';
import { loadReportTool } from './tools/load-report.js';
import { auditTestsTool } from './tools/audit-tests.js';
import { bisectFailureTool } from './tools/bisect-failure.js';
import { saveLoginTool } from './tools/save-login.js';
import { checkTestChangeTool } from './tools/check-test-change.js';
import { quarantineTool } from './tools/quarantine.js';
import { registerPrompts } from './prompts.js';
import { outputSchemaFor } from './tools/structured.js';
import { CACHE_HINTS, SERVER_IDENTITY } from './discovery.js';
import { attachBundledSkill } from './skills.js';

/**
 * Accept unknown argument names instead of dropping them silently, so the
 * result can say which ones were ignored: a planner that writes `waitfor`
 * for `waitFor` otherwise never learns its option did nothing.
 */
function looseInput(schema: StandardSchemaWithJSON): { schema: StandardSchemaWithJSON; known: Set<string> | undefined } {
  const object = schema as unknown as { shape?: Record<string, unknown>; loose?: () => StandardSchemaWithJSON };
  if (!object.shape || typeof object.loose !== 'function') return { schema, known: undefined };
  return { schema: object.loose(), known: new Set(Object.keys(object.shape)) };
}

/** Prepend a note naming arguments the tool does not have, with the closest real name. */
function noteIgnoredArguments(result: ToolResponse, ignored: string[], known: Set<string>): ToolResponse {
  const names = ignored.map((name) => {
    const match = [...known].find((k) => k.toLowerCase() === name.toLowerCase().replace(/[-_]/g, ''));
    return match ? `\`${name}\` (did you mean \`${match}\`?)` : `\`${name}\``;
  });
  const note = `> ⚠️ Ignored unknown argument${ignored.length === 1 ? '' : 's'}: ${names.join(', ')}.\n\n`;
  const [first, ...rest] = result.content;
  const content = first && first.type === 'text' ? [{ ...first, text: note + first.text }, ...rest] : [{ type: 'text' as const, text: note.trim() }, ...result.content];
  return { ...result, content };
}

const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'playwright-e2e-mcp';
export const SERVER_VERSION = readVersion();

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** Standard Schema object (zod v4 `z.object(…)`), as required by MCP SDK v2. */
  inputSchema: StandardSchemaWithJSON;
  /** Spec tool annotations so clients can classify safety before calling. */
  annotations: ToolAnnotations;
  /** `never` keeps the registry homogeneous; each tool narrows on use. */
  handler: (args: never, ctx: ToolContext) => Promise<ToolResponse>;
}

const TOOLS: ToolSpec[] = [
  {
    ...runTestTool,
    title: 'Run E2E tests',
    // Spawns Playwright, which runs the project's own test code (arbitrary
    // Node), hits live apps and writes test-results/ artifacts.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: runTestTool.handler as ToolSpec['handler'],
  },
  {
    ...getRunStatusTool,
    title: 'Check a background run',
    // Reads in-memory run state; cancel stops the run it started.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getRunStatusTool.handler as ToolSpec['handler'],
  },
  {
    ...getFailureTool,
    title: 'Analyze a test failure',
    // Pure reads: JSON report, trace.zip, generated failure summaries.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getFailureTool.handler as ToolSpec['handler'],
  },
  {
    ...loadReportTool,
    title: 'Load a CI report',
    // Reads a report the caller points at; merging blob reports spawns
    // Playwright; records the run in the local history.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: loadReportTool.handler as ToolSpec['handler'],
  },
  {
    ...suggestFixTool,
    title: 'Suggest (and apply) a fix',
    // Opens the trace snapshot or a live page; with apply it edits the spec
    // file and re-runs the test, restoring the file if the re-run fails.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: suggestFixTool.handler as ToolSpec['handler'],
  },
  {
    ...inspectPageTool,
    title: 'Inspect live page DOM',
    // Navigates and evaluates read-only DOM queries; never clicks or types.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: inspectPageTool.handler as ToolSpec['handler'],
  },
  {
    ...listTestsTool,
    title: 'List available tests',
    // Parses test files and config without modifying them.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: listTestsTool.handler as ToolSpec['handler'],
  },
  {
    ...validateSelectorTool,
    title: 'Validate selector or locator',
    // Opens a page and queries the selector; no state-changing actions.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: validateSelectorTool.handler as ToolSpec['handler'],
  },
  {
    ...auditAccessibilityTool,
    title: 'Audit page accessibility',
    // Opens a page and runs axe-core; no state-changing actions beyond the
    // caller's own `actions`.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: auditAccessibilityTool.handler as ToolSpec['handler'],
  },
  {
    ...auditPerformanceTool,
    title: 'Audit page performance',
    // Opens a page and reads performance entries; no state-changing actions
    // beyond the caller's own `actions`.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: auditPerformanceTool.handler as ToolSpec['handler'],
  },
  {
    ...generateE2ETestTool,
    title: 'Generate an E2E test',
    // Writes a spec file; with overwrite it replaces a spec it generated
    // earlier, never any other file.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: generateE2ETestTool.handler as ToolSpec['handler'],
  },
  {
    ...compareVisualStateTool,
    title: 'Compare visual state',
    // Navigates the app; the baseline action overwrites a stored baseline.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: compareVisualStateTool.handler as ToolSpec['handler'],
  },
  {
    ...diagnoseFlakyTool,
    title: 'Diagnose flaky test',
    // Spawns Playwright repeatedly, running the project's test code.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: diagnoseFlakyTool.handler as ToolSpec['handler'],
  },
  {
    ...analyzeHistoryTool,
    title: 'Analyze run history',
    // Reads the local history file only.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: analyzeHistoryTool.handler as ToolSpec['handler'],
  },
  {
    ...auditTestsTool,
    title: 'Audit tests for flake risks',
    // Reads spec files and the history; with fix it edits spec files and
    // re-runs them (the project's test code), restoring them on failure.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: auditTestsTool.handler as ToolSpec['handler'],
  },
  {
    ...bisectFailureTool,
    title: 'Find the commit that broke a test',
    // Runs the project's test code at older commits in a temporary git
    // worktree; the caller's checkout and files are not touched.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: bisectFailureTool.handler as ToolSpec['handler'],
  },
  {
    ...checkTestChangeTool,
    title: 'Check a test fix (heal guard)',
    // Reads spec files and runs read-only git commands.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: checkTestChangeTool.handler as ToolSpec['handler'],
  },
  {
    ...quarantineTool,
    title: 'Quarantine flaky tests',
    // Reads and writes playwright-quarantine.json in the project.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: quarantineTool.handler as ToolSpec['handler'],
  },
  {
    ...saveLoginTool,
    title: 'Save a login session',
    // Drives a browser through a live login and writes a session file.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: saveLoginTool.handler as ToolSpec['handler'],
  },
];

export interface CreateServerOptions {
  /** Default project root for tool calls (defaults to cwd / env var). */
  projectRoot?: string;
  /** Share a store across servers (tests). */
  store?: ToolStore;
  /** Register only these tools (default: all). Used by the hosted HTTP bridge. */
  tools?: readonly string[];
  /** Unauthenticated HTTP mode: see ToolContext.restricted. */
  restricted?: boolean;
  /** Aborted when the HTTP client goes away; combined with the MCP request signal. */
  requestSignal?: AbortSignal;
  /**
   * Allow `PW_MCP_TOOLS=auto` (load more tools on request). Only a server
   * that lives for the whole connection can keep loaded tools, so stdio
   * sets this; the stateless HTTP bridge, which builds a server per
   * request, lists every selected tool instead.
   */
  lazyTools?: boolean;
}

/**
 * Tools that neither drive a browser nor write files. The HTTP bridge
 * serves only these unless it is protected by a token, and runs them in
 * restricted mode, where list-tests scans sources instead of spawning
 * Playwright (which would execute the project's config and spec files).
 */
export const READ_ONLY_TOOLS: readonly string[] = ['list-tests', 'get-failure', 'analyze-history'];

/**
 * Named tool sets for PW_MCP_TOOLS / --tools. Every tool definition costs
 * context on each request (all nineteen are ~11.5k tokens), so a client that
 * only fixes failing suites can load the core loop alone.
 */
export const TOOL_PROFILES: Readonly<Record<string, readonly string[]>> = {
  all: TOOLS.map((tool) => tool.name),
  core: ['run-test', 'get-run-status', 'get-failure', 'suggest-fix', 'check-test-change', 'diagnose-flaky', 'list-tests'],
  triage: ['run-test', 'get-run-status', 'get-failure', 'load-report', 'diagnose-flaky', 'quarantine', 'analyze-history', 'audit-tests', 'bisect-failure', 'check-test-change', 'list-tests'],
  inspect: ['inspect-page', 'validate-selector', 'compare-visual-state', 'audit-accessibility', 'audit-performance', 'save-login'],
  author: ['list-tests', 'save-login', 'inspect-page', 'validate-selector', 'generate-e2e-test', 'check-test-change', 'run-test'],
};

/** The profile names a client can load later with load-tools (see PW_MCP_TOOLS=auto). */
export const LAZY_PROFILE = 'auto';

/**
 * Resolve a comma-separated list of tool names and profile names
 * (`core,inspect-page`). Returns undefined (all tools) for an empty spec;
 * unknown entries are reported, not fatal. `auto` starts with the listed
 * tools (the core loop when none are listed) and sets `lazy`, so the rest
 * can be loaded on request with load-tools.
 */
export function resolveToolSelection(spec: string | undefined): { tools?: string[]; unknown: string[]; lazy?: boolean } {
  const entries = (spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return { unknown: [] };
  const known = new Set(TOOLS.map((tool) => tool.name));
  const selected = new Set<string>();
  const unknown: string[] = [];
  let lazy = false;
  for (const entry of entries) {
    if (entry.toLowerCase() === LAZY_PROFILE) {
      lazy = true;
      continue;
    }
    const profile = TOOL_PROFILES[entry.toLowerCase()];
    if (profile) profile.forEach((name) => selected.add(name));
    else if (known.has(entry)) selected.add(entry);
    else unknown.push(entry);
  }
  if (lazy && selected.size === 0) TOOL_PROFILES.core.forEach((name) => selected.add(name));
  if (selected.size === 0) return { unknown };
  // Keep the registry's order so tools/list is stable.
  return { tools: TOOLS.map((tool) => tool.name).filter((name) => selected.has(name)), unknown, ...(lazy ? { lazy } : {}) };
}

export function resolveDefaultProjectRoot(): string {
  const fromEnv = process.env.PW_MCP_PROJECT_ROOT;
  // A host that collects PW_MCP_PROJECT_ROOT via MCPB user_config but does
  // not substitute `${user_config.project_root}` would pass the placeholder
  // through verbatim; that can never be a real path, so fall back to cwd.
  if (fromEnv && fromEnv.includes('${')) {
    logger.warn('PW_MCP_PROJECT_ROOT contains an unsubstituted ${...} placeholder; using cwd', {
      value: fromEnv,
    });
    return process.cwd();
  }
  const root = fromEnv && fromEnv.trim() !== '' ? fromEnv : process.cwd();
  if (fromEnv) {
    try {
      statSync(root);
    } catch {
      logger.warn('PW_MCP_PROJECT_ROOT does not exist; tool calls will fail until it does', { root });
    }
  }
  return root;
}

/** The first protocol revision without sessions or the initialize handshake. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Protocol versions this server offers: the 2026-07-28 revision first, then
 * every 2025-era version the SDK supports. PW_MCP_PROTOCOL=legacy drops the
 * 2026 revision, for a client that misbehaves when it is offered.
 */
export function supportedProtocolVersions(): string[] {
  const legacy = SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version < MODERN_PROTOCOL_VERSION);
  return process.env.PW_MCP_PROTOCOL === 'legacy' ? legacy : [MODERN_PROTOCOL_VERSION, ...legacy];
}

/** The trace id from a request's `traceparent` (`00-<trace-id>-<span-id>-<flags>`), when valid. */
export function traceContext(meta: Record<string, unknown> | undefined): { traceId?: string; parentSpanId?: string } {
  const value = meta?.[TRACEPARENT_META_KEY];
  if (typeof value !== 'string') return {};
  const match = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(value.trim());
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return {};
  return { traceId: match[1], parentSpanId: match[2] };
}

const LOADABLE_PROFILES = ['triage', 'inspect', 'author', 'all'] as const;

/**
 * load-tools: the one extra tool in PW_MCP_TOOLS=auto. It turns on hidden
 * tools for the rest of the connection and the server tells the client
 * the tool list changed (notifications/tools/list_changed).
 */
function registerLoadTools(server: McpServer, registered: Map<string, RegisteredTool>): void {
  const hidden = () => [...registered.entries()].filter(([, handle]) => !handle.enabled).map(([name]) => name);
  // Name only what each profile adds to the tools already listed.
  const profiles = LOADABLE_PROFILES.filter((name) => name !== 'all')
    .map((name) => `${name} (${TOOL_PROFILES[name].filter((tool) => !registered.get(tool)?.enabled).join(', ')})`)
    .join(', ');
  server.registerTool(
    'load-tools',
    {
      title: 'Load more tools',
      description: `Turn on more playwright-e2e-mcp tools for this session; only the core fix loop is loaded at first. Profiles: ${profiles}, all. Tool names work too.`,
      inputSchema: withCompactJsonSchema(
        z.object({
          load: z.array(z.string()).min(1).max(20).describe("Profiles or tool names, e.g. ['inspect'] or ['audit-accessibility']"),
        }),
      ),
      annotations: { title: 'Load more tools', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const { load } = args as { load: string[] };
      const resolved = resolveToolSelection(load.join(','));
      const turnedOn: string[] = [];
      for (const name of resolved.tools ?? []) {
        const handle = registered.get(name);
        if (handle && !handle.enabled) {
          // Set directly so the client gets one list_changed, not one per tool.
          handle.enabled = true;
          turnedOn.push(name);
        }
      }
      if (turnedOn.length > 0) server.sendToolListChanged();
      const lines: string[] = [];
      if (turnedOn.length > 0) {
        lines.push(`Loaded: ${turnedOn.map((name) => `\`${name}\``).join(', ')}. They are in your tool list now; call them directly.`);
        lines.push('', 'If your client does not show them, it ignores tool list changes: restart the server with `--tools=all` (or the profile you need).');
      } else if ((resolved.tools ?? []).length > 0) {
        lines.push('Those tools are already loaded.');
      }
      if (resolved.unknown.length > 0) lines.push(`Unknown: ${resolved.unknown.map((name) => `\`${name}\``).join(', ')}. Profiles: ${LOADABLE_PROFILES.join(', ')}.`);
      const rest = hidden();
      if (rest.length > 0) lines.push('', `Still available to load: ${rest.join(', ')}.`);
      const failed = resolved.unknown.length > 0 && (resolved.tools ?? []).length === 0;
      return {
        content: [{ type: 'text' as const, text: lines.join('\n').trim() }],
        ...(failed ? { isError: true } : {}),
      };
    },
  );
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const projectRoot = options.projectRoot ?? resolveDefaultProjectRoot();
  const store = options.store ?? createToolStore();
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: SERVER_IDENTITY.title,
      description: SERVER_IDENTITY.description,
      websiteUrl: SERVER_IDENTITY.websiteUrl,
      icons: SERVER_IDENTITY.icons.map((icon) => ({ ...icon, sizes: [...icon.sizes] })),
    },
    {
      // Speak the stateless 2026-07-28 revision to clients that ask for it
      // (server/discover), and the 2025 handshake to everyone else.
      supportedProtocolVersions: supportedProtocolVersions(),
      // 2026-07-28 clients may cache the lists for an hour (SEP-2549).
      cacheHints: CACHE_HINTS,
    },
  );

  let selection = options.tools;
  let lazy = false;
  if (!selection && process.env.PW_MCP_TOOLS) {
    const resolved = resolveToolSelection(process.env.PW_MCP_TOOLS);
    if (resolved.unknown.length > 0) {
      logger.warn('PW_MCP_TOOLS names unknown tools or profiles; ignoring them', {
        unknown: resolved.unknown,
        profiles: [...Object.keys(TOOL_PROFILES), LAZY_PROFILE],
      });
    }
    selection = resolved.tools;
    // Without a long-lived server, `auto` lists every tool: a tool loaded
    // in one request would be gone in the next.
    if (resolved.lazy && options.lazyTools) lazy = true;
    else if (resolved.lazy) selection = undefined;
  }
  const enabled = selection ? TOOLS.filter((tool) => selection.includes(tool.name)) : TOOLS;
  // In auto mode every tool is registered, and the ones not selected stay
  // hidden until load-tools turns them on.
  const registered = new Map<string, RegisteredTool>();
  for (const tool of lazy ? TOOLS : enabled) {
    const input = looseInput(tool.inputSchema);
    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Listed without length/item limits (the full schema still validates).
        inputSchema: withCompactJsonSchema(input.schema),
        // Results always carry structuredContent; the schema that describes
        // it costs context on every request, so PW_MCP_OUTPUT_SCHEMAS=0 drops it.
        ...(process.env.PW_MCP_OUTPUT_SCHEMAS !== '0' && outputSchemaFor(tool.name) ? { outputSchema: outputSchemaFor(tool.name) } : {}),
        annotations: tool.annotations,
        // MCP Apps hosts show the interactive test report next to the result.
        ...(appMetaFor(tool.name) ? { _meta: appMetaFor(tool.name) } : {}),
      },
      async (args: unknown, reqCtx: ServerContext) => {
        const progressToken = reqCtx.mcpReq._meta?.progressToken;
        let lastProgress = -1;
        const ctx: ToolContext = {
          progress:
            progressToken === undefined
              ? undefined
              : (progress, total, message) => {
                  // The spec requires progress to increase with every notification.
                  const value = Math.max(progress, lastProgress + 0.001);
                  lastProgress = value;
                  void reqCtx.mcpReq
                    .notify({
                      method: 'notifications/progress',
                      params: { progressToken, progress: value, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) },
                    })
                    .catch(() => undefined);
                },
          // W3C trace context from the request _meta (SEP-414), so stderr
          // logs line up with the client's OpenTelemetry spans.
          logger: logger.child({ tool: tool.name, ...traceContext(reqCtx.mcpReq._meta) }),
          // v2: the request abort signal lives under ctx.mcpReq.
          signal: options.requestSignal
            ? AbortSignal.any([reqCtx.mcpReq.signal, options.requestSignal])
            : reqCtx.mcpReq.signal,
          store,
          projectRoot,
          restricted: options.restricted === true,
          // Ask the person before writing (MCP elicitation), when the client can.
          confirmWrite: createConfirmWrite({
            tool: tool.name,
            inputResponses: reqCtx.mcpReq.inputResponses,
            envelope: reqCtx.mcpReq.envelope as Record<string, unknown> | undefined,
            sessionCapabilities: server.server.getClientCapabilities(),
          }),
        };
        try {
          const given = (args ?? {}) as Record<string, unknown>;
          const ignored = input.known ? Object.keys(given).filter((key) => !input.known!.has(key)) : [];
          if (ignored.length === 0) return await tool.handler(args as never, ctx);
          const known = Object.fromEntries(Object.entries(given).filter(([key]) => input.known!.has(key)));
          return noteIgnoredArguments(await tool.handler(known as never, ctx), ignored, input.known!);
        } catch (err) {
          // The person has to confirm a file change: hand the question back.
          if (err instanceof ConfirmationPending) return err.result;
          // Backstop: tools already convert their own errors via guard().
          const error = toPlaywrightMcpError(err);
          ctx.logger.error('tool threw unexpectedly', { error, kind: error.kind });
          return toolError(error.kind, error.message, error.hint, error.details);
        }
      },
    );
    registered.set(tool.name, handle);
    if (lazy && !enabled.includes(tool)) handle.disable();
  }
  if (lazy) registerLoadTools(server, registered);

  if (!options.tools) registerPrompts(server);
  // The interactive test report view (MCP Apps).
  if ((lazy ? TOOLS : enabled).some((tool) => appMetaFor(tool.name))) registerApps(server);
  // The playbook for these tools, over the Skills extension (SEP-2640).
  attachBundledSkill(server);

  logger.debug('server created', { version: SERVER_VERSION, projectRoot, tools: enabled.length });
  return server;
}

let shuttingDown = false;

/** Close the server, kill orphaned children, and exit. */
export async function shutdown(server: { close(): Promise<void> }, code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const killed = killActiveChildren();
  logger.info('shutting down', { reason, killedProcesses: killed });
  try {
    await server.close();
  } catch (err) {
    logger.warn('error while closing server', { error: err });
  }
  process.exit(code);
}

/**
 * Serve over stdio and install shutdown handlers. `serveStdio` lets the
 * client's opening message pick the era: a 2026-07-28 client opens with
 * `server/discover`, a 2025 client with `initialize`; either way one server
 * from createServer() is pinned for the connection.
 */
export async function startServer(): Promise<void> {
  const server = serveStdio(() => createServer({ lazyTools: true }), {
    onerror: (error) => logger.warn('stdio transport error', { error }),
  });

  process.on('SIGINT', () => void shutdown(server, 0, 'SIGINT'));
  process.on('SIGTERM', () => void shutdown(server, 0, 'SIGTERM'));
  // The client went away: stdin ends, and we must not leave browsers or
  // test workers running.
  process.stdin.on('end', () => void shutdown(server, 0, 'stdin ended (client disconnected)'));
  process.stdin.on('close', () => void shutdown(server, 0, 'stdin closed (client disconnected)'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { error: err });
    void shutdown(server, 1, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
    void shutdown(server, 1, 'unhandledRejection');
  });

  logger.info('serving over stdio', {
    version: SERVER_VERSION,
    projectRoot: resolveDefaultProjectRoot(),
    tools: resolveToolSelection(process.env.PW_MCP_TOOLS).tools ?? TOOLS.map((tool) => tool.name),
  });
}
