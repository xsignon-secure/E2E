/**
 * Fetch a CI run's Playwright artifacts straight from GitHub Actions or
 * GitLab CI, so `load-report` can take a run URL instead of a folder the user
 * downloaded by hand. Only runs when the user passes such a URL, with their
 * own token from the environment (GITHUB_TOKEN / GH_TOKEN, GITLAB_TOKEN):
 * nothing is fetched otherwise.
 *
 * Artifacts are unpacked under <project>/.playwright-e2e-mcp/ci/<run>/, then
 * the JSON report (or the folder of blob reports) is found in them.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';
import { HISTORY_DIR } from './run-history.js';
import { normalizePath, toNativePath } from './path-utils.js';
import { readZipEntries } from './trace-reader.js';
import { assertUrlAllowed } from './url-policy.js';

export type CiRunRef =
  | { provider: 'github'; owner: string; repo: string; runId: string; api: string }
  | { provider: 'gitlab'; project: string; jobId: string; api: string };

const MAX_ARTIFACTS = 10;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const WANTED = /playwright|report|blob|test-results|results|trace|e2e/i;

/** Recognise a GitHub Actions run or GitLab job URL (or the github:// / gitlab:// shorthands). */
export function parseCiRunRef(input: string): CiRunRef | undefined {
  const text = input.trim();
  const gh = /^https?:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/i.exec(text) ?? /^github:\/\/()([\w.-]+)\/([\w.-]+)\/(?:actions\/)?runs\/(\d+)$/i.exec(text);
  if (gh) {
    const host = gh[1];
    const api = process.env.PW_MCP_GITHUB_API ?? (host && host !== 'github.com' ? `https://${host}/api/v3` : 'https://api.github.com');
    return { provider: 'github', owner: gh[2], repo: gh[3], runId: gh[4], api: api.replace(/\/+$/, '') };
  }
  const gl = /^https?:\/\/([^/]+)\/(.+?)\/-\/jobs\/(\d+)(?:[/?#].*)?$/i.exec(text) ?? /^gitlab:\/\/()(.+?)\/(?:-\/)?jobs\/(\d+)$/i.exec(text);
  if (gl) {
    const api = process.env.PW_MCP_GITLAB_API ?? `https://${gl[1] || 'gitlab.com'}/api/v4`;
    return { provider: 'gitlab', project: gl[2], jobId: gl[3], api: api.replace(/\/+$/, '') };
  }
  return undefined;
}

function token(ref: CiRunRef): { header: Record<string, string> } {
  if (ref.provider === 'github') {
    const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!value) {
      throw new PlaywrightMcpError('Downloading GitHub Actions artifacts needs a token', 'INVALID_INPUT', {
        hint: 'Set GITHUB_TOKEN (or GH_TOKEN) where the MCP server starts, e.g. GITHUB_TOKEN=$(gh auth token), with read access to Actions. Or download the artifact yourself: gh run download <run-id> -D ci-artifacts.',
      });
    }
    return { header: { authorization: `Bearer ${value}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } };
  }
  const value = process.env.GITLAB_TOKEN;
  if (value) return { header: { 'private-token': value } };
  if (process.env.CI_JOB_TOKEN) return { header: { 'job-token': process.env.CI_JOB_TOKEN } };
  throw new PlaywrightMcpError('Downloading GitLab job artifacts needs a token', 'INVALID_INPUT', {
    hint: 'Set GITLAB_TOKEN (a personal or project access token with read_api) where the MCP server starts, or download the artifacts yourself.',
  });
}

async function getJson<T>(url: string, header: Record<string, string>, signal?: AbortSignal): Promise<T> {
  await assertUrlAllowed(url);
  const response = await fetch(url, { headers: header, signal });
  if (!response.ok) {
    throw new PlaywrightMcpError(`CI API answered ${response.status} for ${url.replace(/\?.*$/, '')}`, 'REPORT_MISSING', {
      hint: response.status === 404 || response.status === 401 || response.status === 403 ? 'Check the URL and that the token can read this repository\'s Actions / CI artifacts.' : undefined,
    });
  }
  return (await response.json()) as T;
}

async function getBytes(url: string, header: Record<string, string>, signal?: AbortSignal): Promise<Buffer> {
  await assertUrlAllowed(url);
  // fetch drops the authorization header when the redirect leaves the API host,
  // so the signed storage URL is fetched without our token.
  const response = await fetch(url, { headers: header, signal, redirect: 'follow' });
  if (!response.ok) throw new PlaywrightMcpError(`Artifact download answered ${response.status}`, 'REPORT_MISSING');
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > MAX_DOWNLOAD_BYTES) throw new PlaywrightMcpError(`Artifact is too large (${Math.round(size / 1_000_000)} MB)`, 'REPORT_MISSING');
  return Buffer.from(await response.arrayBuffer());
}

/** Unpack a zip under `dest`, refusing entries that would land outside it. Returns files written. */
export async function unzipInto(zip: Buffer, dest: string): Promise<number> {
  const entries = readZipEntries(zip);
  const root = path.resolve(toNativePath(dest));
  let written = 0;
  for (const [name, data] of entries) {
    if (name.endsWith('/') || name.includes('\0')) continue;
    const target = path.resolve(root, name.replace(/\\/g, '/'));
    if (target !== root && !target.startsWith(root + path.sep)) continue; // zip slip
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    written += 1;
  }
  return written;
}

export interface FetchedRun {
  dir: string;
  artifacts: string[];
  commit?: string;
  branch?: string;
  url: string;
}

/** Download the run's Playwright artifacts into the project and return where they are. */
export async function fetchCiRun(ref: CiRunRef, root: string, signal?: AbortSignal): Promise<FetchedRun> {
  const { header } = token(ref);
  if (ref.provider === 'github') {
    const base = `${ref.api}/repos/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}`;
    const run = await getJson<{ head_sha?: string; head_branch?: string; html_url?: string }>(base, header, signal);
    const list = await getJson<{ artifacts?: Array<{ name: string; size_in_bytes?: number; expired?: boolean; archive_download_url: string }> }>(`${base}/artifacts?per_page=100`, header, signal);
    const live = (list.artifacts ?? []).filter((a) => !a.expired);
    if (live.length === 0) {
      throw new PlaywrightMcpError(`Run ${ref.runId} has no artifacts${(list.artifacts ?? []).length ? ' left (they expired)' : ''}`, 'REPORT_MISSING', {
        hint: 'Upload the Playwright report from the job (actions/upload-artifact with playwright-report/ or blob-report/ and test-results/), then load the next run.',
      });
    }
    const wanted = live.filter((a) => WANTED.test(a.name));
    const picked = (wanted.length > 0 ? wanted : live).slice(0, MAX_ARTIFACTS);
    const dir = normalizePath(path.join(toNativePath(root), HISTORY_DIR, 'ci', `github-${ref.runId}`));
    let total = 0;
    for (const artifact of picked) {
      total += artifact.size_in_bytes ?? 0;
      if (total > MAX_DOWNLOAD_BYTES) break;
      // The token only ever goes to the API host the user's URL named.
      const sameHost = new URL(artifact.archive_download_url).origin === new URL(ref.api).origin;
      const zip = await getBytes(artifact.archive_download_url, sameHost ? header : {}, signal);
      await unzipInto(zip, `${dir}/${artifact.name.replace(/[^\w.-]+/g, '_')}`);
    }
    return { dir, artifacts: picked.map((a) => a.name), commit: run.head_sha, branch: run.head_branch, url: run.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}` };
  }
  const project = encodeURIComponent(ref.project);
  const job = await getJson<{ commit?: { id?: string }; ref?: string; web_url?: string }>(`${ref.api}/projects/${project}/jobs/${ref.jobId}`, header, signal);
  const zip = await getBytes(`${ref.api}/projects/${project}/jobs/${ref.jobId}/artifacts`, header, signal);
  const dir = normalizePath(path.join(toNativePath(root), HISTORY_DIR, 'ci', `gitlab-${ref.jobId}`));
  await unzipInto(zip, dir);
  return { dir, artifacts: ['job artifacts'], commit: job.commit?.id, branch: job.ref, url: job.web_url ?? '' };
}

/**
 * The report to load from unpacked artifacts: a Playwright JSON report
 * (results.json first), else the folder holding blob-report zips.
 */
export async function findReport(dir: string): Promise<string | undefined> {
  const jsons: string[] = [];
  const blobDirs = new Set<string>();
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(toNativePath(current), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) jsons.push(full);
      else if (/^report.*\.zip$/.test(entry.name)) blobDirs.add(current);
    }
  };
  await walk(dir, 0);
  jsons.sort((a, b) => Number(/results\.json$|report\.json$/.test(b)) - Number(/results\.json$|report\.json$/.test(a)));
  for (const file of jsons) {
    const info = await stat(toNativePath(file)).catch(() => null);
    if (!info || info.size > 200_000_000) continue;
    const head = (await readFile(toNativePath(file), 'utf8').catch(() => '')).slice(0, 4_000_000);
    if (/"suites"\s*:/.test(head) && /"config"\s*:/.test(head)) return file;
  }
  return [...blobDirs][0];
}
