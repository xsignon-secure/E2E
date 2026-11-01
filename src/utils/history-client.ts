/**
 * Shared history client: CI runs from every machine in one history, kept
 * by a history server the team hosts itself (history-server/ in this repo,
 * free and MIT like everything else).
 *
 * Strictly opt-in. Nothing here makes a network call unless
 * PW_MCP_HISTORY_TOKEN is set; without it the server behaves exactly as
 * before. PW_MCP_HISTORY_URL points at the team's history server. There is
 * deliberately no built-in default URL: the token only ever goes where the
 * user pointed it. PW_MCP_PRO_KEY / PW_MCP_PRO_URL / PW_MCP_PRO_PROJECT,
 * the names from 0.7 and 0.8, still work.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';
import type { HistoryEntry } from './run-history.js';
import { parseHistory } from './run-history.js';

const PROJECT_RE = /^[A-Za-z0-9][\w./-]{0,99}$/;
const UPLOAD_BATCH = 100;

export interface HistorySettings {
  key: string;
  url: string;
}

const pick = (env: NodeJS.ProcessEnv, name: string, legacy: string): string | undefined => {
  const value = env[name]?.trim() || env[legacy]?.trim();
  return value || undefined;
};

/** The shared history settings, or undefined when none are set (the normal case). */
export function historySettings(env: NodeJS.ProcessEnv = process.env): HistorySettings | undefined {
  const key = pick(env, 'PW_MCP_HISTORY_TOKEN', 'PW_MCP_PRO_KEY');
  if (!key) return undefined;
  const url = (pick(env, 'PW_MCP_HISTORY_URL', 'PW_MCP_PRO_URL') ?? '').replace(/\/+$/, '');
  if (!url) {
    throw new PlaywrightMcpError('PW_MCP_HISTORY_TOKEN is set but PW_MCP_HISTORY_URL is not', 'INVALID_INPUT', {
      hint: "Set PW_MCP_HISTORY_URL to your team's history server, or unset PW_MCP_HISTORY_TOKEN.",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlaywrightMcpError(`PW_MCP_HISTORY_URL is not a URL: ${url}`, 'INVALID_INPUT');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new PlaywrightMcpError('PW_MCP_HISTORY_URL must use https', 'INVALID_INPUT', { hint: 'The token is sent with every request.' });
  }
  return { key, url };
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  });
}

/**
 * The project name runs are filed under: PW_MCP_HISTORY_PROJECT, else the
 * GitHub repository (owner/name, from CI or the origin remote), else the
 * folder name. The same rule on CI and laptops, so both see one history.
 */
export async function historyProjectName(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates: Array<string | undefined> = [env.PW_MCP_HISTORY_PROJECT, env.PW_MCP_PRO_PROJECT, env.GITHUB_REPOSITORY];
  const remote = await git(['remote', 'get-url', 'origin'], root);
  const match = remote ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote) : null;
  candidates.push(match?.[1], path.basename(root));
  for (const raw of candidates) {
    const name = raw?.trim();
    if (name && PROJECT_RE.test(name) && !name.includes('..')) return name;
  }
  return 'project';
}

async function call(settings: HistorySettings, method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${settings.url}/api/v1/${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${settings.key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new PlaywrightMcpError(`The history server is unreachable (${settings.url}): ${(error as Error).message}`, 'UNKNOWN', {
      hint: 'Check the network and PW_MCP_HISTORY_URL; local history still works.',
    });
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
  if (!response.ok) {
    throw new PlaywrightMcpError(`History server: ${data.error ?? `HTTP ${response.status}`}`, response.status === 401 ? 'INVALID_INPUT' : 'UNKNOWN', {
      hint: data.hint,
    });
  }
  return data;
}

export async function uploadRuns(settings: HistorySettings, project: string, runs: HistoryEntry[]): Promise<{ stored: number; skipped: number }> {
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < runs.length; i += UPLOAD_BATCH) {
    const batch = runs.slice(i, i + UPLOAD_BATCH);
    const result = (await call(settings, 'POST', 'runs', { project, runs: batch })) as { stored?: number; skipped?: number };
    stored += result.stored ?? 0;
    skipped += result.skipped ?? 0;
  }
  return { stored, skipped };
}

export async function fetchRuns(settings: HistorySettings, project: string, limit: number): Promise<HistoryEntry[]> {
  const result = (await call(settings, 'GET', `runs?project=${encodeURIComponent(project)}&limit=${limit}`)) as { runs?: unknown[] };
  // Same parser as the local file: anything malformed is dropped.
  return parseHistory((result.runs ?? []).map((run) => JSON.stringify(run)).join('\n'));
}

/** Local and cloud runs together, oldest first, without duplicates. */
export function mergeRuns(local: HistoryEntry[], cloud: HistoryEntry[], last: number): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const entry of [...local, ...cloud]) {
    const key = `${entry.at}\u0000${entry.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-last);
}
