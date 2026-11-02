/**
 * Tool — check-mocks: catch network mocks that drifted from the real API.
 * Finds route.fulfill bodies (TypeScript/JavaScript and pytest-playwright
 * specs) and routeFromHAR recordings, calls each mocked GET endpoint on the
 * live server, and compares the JSON shapes: fields the mock relies on that
 * the API no longer sends, changed types, values that are now null, and
 * endpoints that are gone. Only GET requests are sent; mocks of writes are
 * listed, never replayed.
 */

import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { detectProject, findTestFiles } from '../utils/project-detector.js';
import { assertRealPathInside, isPathInside, joinProjectPath, sanitizeUserPath, toNativePath } from '../utils/path-utils.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import { diffShapes, findMocks, liveUrl, mocksFromHar, shapeOf } from '../utils/mock-drift.js';
import type { DriftFinding, FoundMock } from '../utils/mock-drift.js';
import { loginEnvAllowed } from './save-login.js';
import { guard, resolveProjectRoot, toolText } from './shared.js';

const MAX_MOCKS = 40;
const MAX_BODY_BYTES = 2_000_000;
const PY_IGNORED = new Set(['node_modules', '.venv', 'venv', 'env', '__pycache__', 'site-packages', 'dist', 'build', '.git', '.tox']);

const checkMocksInput = z.object({
  baseUrl: z.string().optional().describe("Live server for relative mock URLs, e.g. 'http://localhost:3000' or a staging URL (default: use.baseURL from the Playwright config)"),
  urls: z
    .record(z.string(), z.string())
    .optional()
    .describe("Real URLs for wildcard or regex mocks: { '**/api/items/*': '/api/items/1' }"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Headers for the live calls, e.g. { Authorization: "Bearer {{env:E2E_API_TOKEN}}" }; {{env:NAME}} reads E2E_*/TEST_*/PW_* variables so tokens stay out of chat'),
  filter: z.string().optional().describe('Only test files whose path contains this text'),
  projectRoot: z.string().optional().describe('Project directory (default: server root)'),
  timeoutMs: z.number().int().min(1_000).max(60_000).optional().describe('Limit per live call (default 10000)'),
});

export type CheckMocksInput = z.infer<typeof checkMocksInput>;
export const checkMocksSchema = checkMocksInput;

/** Replace {{env:NAME}} in header values with allowed environment variables. */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = value.replace(/\{\{env:([A-Z0-9_]+)\}\}/g, (_all, env: string) => {
      if (!loginEnvAllowed(env)) {
        throw new PlaywrightMcpError(`{{env:${env}}} is not an allowed variable`, 'INVALID_INPUT', {
          hint: 'Name it E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_* (e.g. E2E_API_TOKEN), or list it in PW_MCP_LOGIN_ENV.',
        });
      }
      const resolved = process.env[env];
      if (resolved === undefined || resolved === '') {
        throw new PlaywrightMcpError(`Not set in the server's environment: ${env}`, 'INVALID_INPUT', {
          hint: 'Set it where the MCP server starts (the env block of your MCP client config), then restart the server.',
        });
      }
      return resolved;
    });
  }
  return out;
}

async function pythonTestFiles(root: string, limit = 2_000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= limit) return;
    const entries = await readdir(toNativePath(dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || out.length >= limit) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !PY_IGNORED.has(entry.name)) await walk(full, depth + 1);
      else if (entry.isFile() && (/^test_.*\.py$/.test(entry.name) || /_test\.py$/.test(entry.name) || entry.name === 'conftest.py')) {
        out.push(full.slice(root.length + 1));
      }
    }
  };
  await walk(root, 0);
  return out.sort();
}

/** Best-effort use.baseURL from the Playwright config text. */
async function configBaseUrl(configPath: string | null): Promise<string | undefined> {
  if (!configPath) return undefined;
  const text = await readFile(toNativePath(configPath), 'utf8').catch(() => '');
  const match = /\bbaseURL\s*:\s*(?:process\.env\.\w+\s*(?:\?\?|\|\|)\s*)?(['"`])(https?:\/\/[^'"`$]+)\1/.exec(text);
  return match?.[2];
}

interface LiveResult {
  status: number;
  json?: unknown;
  contentType: string;
  error?: string;
}

/** GET a URL, following up to three redirects, each checked against the URL policy. */
async function fetchLive(url: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<LiveResult> {
  let target = url;
  for (let hop = 0; hop < 4; hop += 1) {
    await assertUrlAllowed(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const response = await fetch(target, { method: 'GET', headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        target = new URL(response.headers.get('location')!, target).toString();
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) return { status: response.status, contentType, error: 'response too large to compare' };
      try {
        return { status: response.status, contentType, json: JSON.parse(text) };
      } catch {
        return { status: response.status, contentType };
      }
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? `no answer within ${timeoutMs} ms` : ((error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message);
      return { status: 0, contentType: '', error: message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return { status: 0, contentType: '', error: 'too many redirects' };
}

export interface MockCheck {
  mock: FoundMock;
  url?: string;
  /** Why the mock was not compared. */
  skipped?: string;
  live?: { status: number };
  findings: DriftFinding[];
}

/** Compare one mock with a live answer (exported for unit tests). */
export function compareWithLive(mock: FoundMock, live: LiveResult): DriftFinding[] {
  if (live.error && live.status === 0) return [{ rule: 'server-error', severity: 'medium', path: '', message: `The live endpoint did not answer: ${live.error}.` }];
  if (live.status === 404 || live.status === 410) {
    return [{ rule: 'endpoint-gone', severity: 'high', path: '', message: `The live endpoint answers **${live.status}**: the mocked route no longer exists (or moved).` }];
  }
  if (live.status >= 500) return [{ rule: 'server-error', severity: 'medium', path: '', message: `The live endpoint answers **${live.status}**; its shape could not be checked.` }];
  if (live.status >= 400) return [{ rule: 'status-changed', severity: 'medium', path: '', message: `The live endpoint answers **${live.status}** where the mock answers ${mock.status}.` }];
  if (live.json === undefined) {
    return [{ rule: 'not-json', severity: 'high', path: '', message: `The mock returns JSON but the live endpoint returns ${live.contentType ? `\`${live.contentType.split(';')[0]}\`` : 'something else'}.` }];
  }
  return diffShapes(shapeOf(mock.body), shapeOf(live.json));
}

const ICON: Record<DriftFinding['severity'], string> = { high: '❌', medium: '⚠️', low: 'ℹ️' };

export function renderMockReport(checks: MockCheck[], baseUrl: string | undefined, filesScanned: number): { text: string; status: 'DRIFT' | 'OK' | 'NOTHING CHECKED' } {
  const compared = checks.filter((c) => !c.skipped);
  const drifted = compared.filter((c) => c.findings.some((f) => f.severity !== 'low'));
  const status = compared.length === 0 ? 'NOTHING CHECKED' : drifted.length > 0 ? 'DRIFT' : 'OK';
  const lines: string[] = [];
  if (status === 'DRIFT') lines.push(`## ⚠️ DRIFT — ${drifted.length} of ${compared.length} mock(s) no longer match the live API`);
  else if (status === 'OK') lines.push(`## ✅ OK — ${compared.length} mock(s) match the live API`);
  else lines.push(checks.length === 0 ? '## No network mocks found' : '## Nothing compared');
  lines.push('');
  lines.push(`**Live API:** ${baseUrl ?? '(absolute mock URLs only)'}  |  **Mocks found:** ${checks.length} in ${filesScanned} file(s)${checks.length > compared.length ? ` (${checks.length - compared.length} skipped)` : ''}`, '');
  if (checks.length === 0) {
    lines.push('No `route.fulfill` with a JSON body and no `routeFromHAR` was found in the test files.');
    return { text: lines.join('\n'), status };
  }
  const order = [...compared].sort((a, b) => Number(b.findings.some((f) => f.severity === 'high')) - Number(a.findings.some((f) => f.severity === 'high')));
  for (const check of order) {
    const where = `${check.mock.file}:${check.mock.line}`;
    const route = `${check.mock.method ?? 'GET'} ${check.url ?? check.mock.pattern}`;
    const bad = check.findings.some((f) => f.severity !== 'low');
    lines.push(`### ${bad ? '❌' : '✅'} \`${where}\` — \`${route}\`${check.mock.har ? ` (HAR \`${check.mock.har}\`)` : ''}`);
    if (check.findings.length === 0) lines.push('Matches the live response.');
    for (const finding of check.findings.slice(0, 12)) lines.push(`- ${ICON[finding.severity]} ${finding.message}`);
    if (check.findings.length > 12) lines.push(`- _…${check.findings.length - 12} more_`);
    lines.push('');
  }
  const skipped = checks.filter((c) => c.skipped);
  if (skipped.length > 0) {
    lines.push('### Skipped', '');
    for (const check of skipped.slice(0, 20)) lines.push(`- \`${check.mock.file}:${check.mock.line}\` \`${check.mock.pattern}\`: ${check.skipped}`);
    if (skipped.length > 20) lines.push(`- _…${skipped.length - 20} more_`);
    lines.push('');
  }
  if (status === 'DRIFT') {
    lines.push(
      '**What to do:** update each drifted mock to the live shape (or re-record the HAR with `har: { mode: "record" }`), then run the tests again: the app code that reads the changed fields is where production breaks. A contract test (Pact or a JSON schema shared with the backend) keeps this from coming back.',
    );
  }
  return { text: lines.join('\n'), status };
}

/** Find, call and compare every mock in the project. Used by the tool and the `mocks` CLI. */
export async function checkProjectMocks(
  root: string,
  options: { baseUrl?: string; urls?: Record<string, string>; headers?: Record<string, string>; rawHeaders?: Record<string, string>; filter?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ checks: MockCheck[]; baseUrl?: string; filesScanned: number }> {
  const detection = await detectProject(root);
  let testDir: string | null = detection.testDir;
  if (testDir !== null && !isPathInside(testDir, root)) testDir = null;
  const wanted = options.filter?.toLowerCase();
  const files = [...(await findTestFiles(root, { testDir, limit: 2_000 })), ...(await pythonTestFiles(root))]
    .filter((f, i, all) => all.indexOf(f) === i)
    .filter((f) => !wanted || f.toLowerCase().includes(wanted));
  const baseUrl = options.baseUrl ?? (await configBaseUrl(detection.configPath));
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new PlaywrightMcpError(`baseUrl must be an http(s) URL: ${baseUrl}`, 'INVALID_INPUT', { hint: "E.g. 'http://localhost:3000'." });
  }
  const headers = { ...(options.rawHeaders ?? {}), ...resolveHeaders(options.headers) };

  const mocks: FoundMock[] = [];
  for (const file of files) {
    const source = await readFile(toNativePath(joinProjectPath(root, file)), 'utf8').catch(() => '');
    if (!/\.(route|routeFromHAR|route_from_har)\s*\(/.test(source)) continue;
    for (const mock of findMocks(file, source)) {
      if (mock.har) {
        const harPath = sanitizeUserPath(mock.har, root);
        const ok = await assertRealPathInside(harPath, root).then(() => true, () => false);
        const text = ok ? await readFile(toNativePath(harPath), 'utf8').catch(() => undefined) : undefined;
        if (text === undefined) mocks.push({ ...mock, method: 'GET' });
        else mocks.push(...mocksFromHar(file, mock.line, mock.har, text).map((entry) => ({ ...entry, pattern: harUrl(entry.pattern, baseUrl) })));
        continue;
      }
      if (mock.bodyFile && mock.body === undefined) {
        const bodyPath = sanitizeUserPath(mock.bodyFile, root);
        const ok = await assertRealPathInside(bodyPath, root).then(() => true, () => false);
        const text = ok ? await readFile(toNativePath(bodyPath), 'utf8').catch(() => undefined) : undefined;
        try {
          if (text !== undefined) mock.body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
      }
      mocks.push(mock);
    }
  }

  const checks: MockCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  for (const mock of mocks) {
    if (checks.filter((c) => !c.skipped).length >= MAX_MOCKS) {
      checks.push({ mock, skipped: `limit of ${MAX_MOCKS} live calls reached; narrow with filter`, findings: [] });
      continue;
    }
    if (mock.har && mock.body === undefined) {
      checks.push({ mock, skipped: 'HAR file not found in the project', findings: [] });
      continue;
    }
    if (mock.method && mock.method !== 'GET') {
      checks.push({ mock, skipped: `${mock.method} mock: only GET endpoints are called, so writes are never replayed`, findings: [] });
      continue;
    }
    if (mock.status < 200 || mock.status >= 300) {
      checks.push({ mock, skipped: `mocks an error (${mock.status}) on purpose`, findings: [] });
      continue;
    }
    if (mock.body === undefined) {
      checks.push({ mock, skipped: 'the body is not a JSON literal this check can read', findings: [] });
      continue;
    }
    const target = liveUrl(mock, baseUrl, options.urls);
    if ('reason' in target) {
      checks.push({ mock, skipped: target.reason, findings: [] });
      continue;
    }
    const live = await fetchLive(target.url, headers, timeoutMs, options.signal);
    checks.push({ mock, url: target.url, live: { status: live.status }, findings: compareWithLive(mock, live) });
  }
  return { checks, baseUrl, filesScanned: files.length };
}

/** Point a HAR entry recorded against another host at baseUrl, keeping path and query. */
function harUrl(recorded: string, baseUrl: string | undefined): string {
  if (!baseUrl) return recorded;
  try {
    const url = new URL(recorded);
    return new URL(url.pathname + url.search, baseUrl).toString();
  } catch {
    return recorded;
  }
}

export const checkMocksTool = {
  name: 'check-mocks',
  description:
    "Catch network mocks that drifted from the real API: finds route.fulfill JSON bodies (TS/JS and pytest specs) and routeFromHAR files, GETs each mocked endpoint on the live server (baseUrl) and reports fields the mock has that the API no longer sends, changed types, new nulls and endpoints that are gone. Only GET is sent; write mocks are listed, not replayed.",
  inputSchema: checkMocksSchema,
  handler: async (args: CheckMocksInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('check-mocks', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const { checks, baseUrl, filesScanned } = await checkProjectMocks(root, { ...args, signal: ctx.signal });
      const report = renderMockReport(checks, baseUrl, filesScanned);
      const findings = checks.flatMap((check) =>
        check.findings.map((finding) => ({
          file: check.mock.file,
          line: check.mock.line,
          rule: finding.rule,
          severity: finding.severity,
          message: `${check.url ?? check.mock.pattern}: ${finding.message.replace(/\*\*/g, '').replace(/`/g, '')}`,
        })),
      );
      return toolText(report.text, { ok: report.status !== 'DRIFT', status: report.status, findings: findings.slice(0, 100), total: findings.length });
    }),
};

