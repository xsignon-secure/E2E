/**
 * MCP Apps (SEP-1865, extension `io.modelcontextprotocol/ui`): an
 * interactive test report that Claude, ChatGPT, Cursor and other MCP Apps
 * hosts render next to the run-test, get-run-status and get-failure results.
 *
 * The tools say which view to show in their `_meta.ui.resourceUri`; the
 * host reads the `ui://` resource, renders it in a sandboxed iframe and
 * hands it the tool result. Hosts that do not support MCP Apps ignore the
 * metadata and show the text result exactly as before, so nothing changes
 * for them.
 *
 * The view makes no network requests (it declares no CSP domains) and only
 * calls this server's own tools through the host.
 *
 * Set PW_MCP_APPS=0 to turn it off.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { TEST_REPORT_HTML } from './test-report-html.js';

/** The MCP Apps resource MIME type (`text/html;profile=mcp-app`). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Older hosts read the view from this flat key (`ui/resourceUri`). */
export const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';

export const TEST_REPORT_URI = 'ui://playwright-e2e-mcp/test-report.html';

/** Tools whose results the report view can show. */
export const REPORT_TOOLS: ReadonlySet<string> = new Set(['run-test', 'get-run-status', 'get-failure']);

export function appsEnabled(): boolean {
  return process.env.PW_MCP_APPS !== '0';
}

/** The `_meta` a tool declares so MCP Apps hosts show the report, or undefined. */
export function appMetaFor(toolName: string): Record<string, unknown> | undefined {
  if (!appsEnabled() || !REPORT_TOOLS.has(toolName)) return undefined;
  return { ui: { resourceUri: TEST_REPORT_URI }, [LEGACY_RESOURCE_URI_KEY]: TEST_REPORT_URI };
}

/** Rendering hints for the host: a border, and no outside origins at all. */
const RESOURCE_UI_META = {
  prefersBorder: true,
  csp: { connectDomains: [], resourceDomains: [] },
};

/** Register the report view resource. A no-op when PW_MCP_APPS=0. */
export function registerApps(server: McpServer): void {
  if (!appsEnabled()) return;
  server.registerResource(
    'test-report',
    TEST_REPORT_URI,
    {
      title: 'Interactive test report',
      description: 'The view MCP Apps hosts show for run-test, get-run-status and get-failure results.',
      mimeType: MCP_APP_MIME_TYPE,
      _meta: { ui: RESOURCE_UI_META },
    },
    async () => ({
      contents: [{ uri: TEST_REPORT_URI, mimeType: MCP_APP_MIME_TYPE, text: TEST_REPORT_HTML, _meta: { ui: RESOURCE_UI_META } }],
    }),
  );
}
