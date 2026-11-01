/**
 * The history server API, as one function from a Web Request to a Response,
 * so the same code runs on Vercel, Azure Functions, plain Node (server.mjs)
 * and in tests.
 *
 *   GET    /api/v1/health                      no key
 *   POST   /api/v1/runs        { project, runs: HistoryEntry[] }
 *   GET    /api/v1/runs?project=&limit=        oldest first
 *   GET    /api/v1/projects
 *   GET    /api/v1/summary?project=&lastRuns=  flaky / broken ranking
 *   DELETE /api/v1/projects?project=           delete a project's runs
 *
 * Every call but health needs `Authorization: Bearer <token>` (HISTORY_TOKENS).
 */

import { summarize } from './summary.mjs';
import { LIMITS } from './store.mjs';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RUNS_PER_UPLOAD = 200;
const MAX_TESTS_PER_RUN = 2_000;
const PROJECT_RE = /^[A-Za-z0-9][\w.\/-]{0,99}$/;
const STATUSES = new Set(['passed', 'failed', 'flaky', 'skipped', 'timedOut', 'interrupted', 'unknown']);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const fail = (status, error, hint) => json(status, hint ? { error, hint } : { error });

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

/** Keep only the fields the MCP writes, with sane sizes; null when the entry is unusable. */
export function cleanRun(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.tests)) return null;
  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  if (!at || Date.parse(at) > Date.now() + 86_400_000) return null;
  const tests = [];
  for (const t of raw.tests.slice(0, MAX_TESTS_PER_RUN)) {
    if (!t || typeof t.file !== 'string' || typeof t.title !== 'string') continue;
    const test = { file: t.file.slice(0, 300), title: t.title.slice(0, 500), status: STATUSES.has(t.status) ? t.status : 'unknown' };
    if (typeof t.project === 'string') test.project = t.project.slice(0, 100);
    if (num(t.ms) !== undefined) test.ms = num(t.ms);
    if (typeof t.kind === 'string') test.kind = t.kind.slice(0, 40);
    if (typeof t.msg === 'string') test.msg = t.msg.slice(0, 1_000);
    tests.push(test);
  }
  const stats =
    raw.stats && typeof raw.stats === 'object'
      ? { passed: num(raw.stats.passed) ?? 0, failed: num(raw.stats.failed) ?? 0, flaky: num(raw.stats.flaky) ?? 0, skipped: num(raw.stats.skipped) ?? 0 }
      : null;
  const run = {
    v: 1,
    at,
    source: clip(raw.source, 40) ?? 'upload',
    command: clip(raw.command, 1_000) ?? '',
    ok: raw.ok === true,
    durationMs: num(raw.durationMs) ?? 0,
    stats,
    tests,
  };
  if (typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.commit)) run.commit = raw.commit;
  if (typeof raw.branch === 'string') run.branch = raw.branch.slice(0, 200);
  if (typeof raw.subject === 'string') run.subject = raw.subject.slice(0, 200);
  if (raw.dirty === true) run.dirty = true;
  if (typeof raw.buildUrl === 'string' && /^https:\/\//.test(raw.buildUrl)) run.buildUrl = raw.buildUrl.slice(0, 500);
  return run;
}

function bearer(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : undefined;
}

function projectParam(url) {
  const project = url.searchParams.get('project') ?? '';
  return PROJECT_RE.test(project) && !project.includes('..') ? project : undefined;
}

function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return { error: fail(413, 'Upload too large', `Send at most ${MAX_RUNS_PER_UPLOAD} runs or 4 MB per request.`) };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: fail(413, 'Upload too large', `Send at most ${MAX_RUNS_PER_UPLOAD} runs or 4 MB per request.`) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: fail(400, 'Body is not JSON') };
  }
}

/**
 * @param {{ store: ReturnType<import('./store.mjs').memoryStore>, validate: (token: string) => Promise<{ok: boolean, team?: string, reason?: string}> }} deps
 */
export function createHandler({ store, validate }) {
  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method.toUpperCase();

    if (path === '/api/v1/health') return json(200, { ok: true, service: 'playwright-e2e-mcp-history' });
    if (!path.startsWith('/api/v1/')) return fail(404, 'Not found');

    const key = bearer(request);
    if (!key) return fail(401, 'Missing token', 'Send Authorization: Bearer <token> (PW_MCP_HISTORY_TOKEN).');
    const access = await validate(key);
    if (!access.ok) return fail(401, 'This token is not accepted here', 'Ask whoever runs this history server for a token listed in its HISTORY_TOKENS.');
    const team = access.team;

    try {
      if (path === '/api/v1/runs' && method === 'POST') {
        const { body, error } = await readJson(request);
        if (error) return error;
        const project = typeof body?.project === 'string' && PROJECT_RE.test(body.project) && !body.project.includes('..') ? body.project : undefined;
        if (!project) return fail(400, 'Invalid project name', 'Use letters, digits and . _ / - (e.g. "acme/shop"), up to 100 characters.');
        if (!Array.isArray(body.runs)) return fail(400, 'runs must be an array of history entries');
        if (body.runs.length > MAX_RUNS_PER_UPLOAD) return fail(413, `At most ${MAX_RUNS_PER_UPLOAD} runs per upload`);
        if (!(await store.hasProject(team, project)) && (await store.projectCount(team)) >= LIMITS.projects) {
          return fail(403, `Project limit reached (${LIMITS.projects})`, 'Delete an old project with DELETE /api/v1/projects?project=<name>.');
        }
        const runs = body.runs.map(cleanRun).filter(Boolean);
        const stored = runs.length ? await store.addRuns(team, project, runs) : 0;
        return json(200, { project, received: body.runs.length, stored, skipped: body.runs.length - stored });
      }
      if (path === '/api/v1/runs' && method === 'GET') {
        const project = projectParam(url);
        if (!project) return fail(400, 'Pass ?project=<name>');
        const limit = intParam(url, 'limit', 100, 1, 1_000);
        return json(200, { project, runs: await store.listRuns(team, project, limit) });
      }
      if (path === '/api/v1/projects' && method === 'GET') {
        return json(200, { projects: await store.listProjects(team), limits: LIMITS });
      }
      if (path === '/api/v1/projects' && method === 'DELETE') {
        const project = projectParam(url);
        if (!project) return fail(400, 'Pass ?project=<name>');
        return json(200, { project, deleted: await store.deleteProject(team, project) });
      }
      if (path === '/api/v1/summary' && method === 'GET') {
        const project = projectParam(url);
        if (!project) return fail(400, 'Pass ?project=<name>');
        const runs = await store.listRuns(team, project, intParam(url, 'lastRuns', 50, 2, 500));
        return json(200, { project, ...summarize(runs) });
      }
      return fail(405, `${method} ${path} is not supported`);
    } catch (error) {
      console.error('history-server', error);
      return fail(500, 'Something went wrong on the history server', 'Try again; if it keeps failing, check the server logs around the time of the request.');
    }
  };
}
