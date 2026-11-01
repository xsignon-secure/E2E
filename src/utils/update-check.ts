/**
 * Asks the npm registry for the latest published version of this package and
 * compares it with the running one. Used by `doctor`, which a person runs on
 * purpose; the MCP server itself never calls this.
 *
 * The request carries nothing but the package name (no project data, no
 * identifiers). It is skipped when PW_MCP_NO_UPDATE_CHECK=1 or when called
 * with `offline`, and any failure (no network, a proxy, a slow registry)
 * resolves to `unknown` instead of throwing.
 */

export const PACKAGE_NAME = 'playwright-e2e-mcp';
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type UpdateStatus =
  | { state: 'current'; current: string; latest: string }
  | { state: 'outdated'; current: string; latest: string }
  | { state: 'ahead'; current: string; latest: string }
  | { state: 'unknown'; current: string; reason: string }
  | { state: 'skipped'; current: string; reason: string };

/** Compares two x.y.z versions (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface UpdateCheckOptions {
  offline?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function checkForUpdate(current: string, options: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const env = options.env ?? process.env;
  if (options.offline) return { state: 'skipped', current, reason: '--offline' };
  if (env.PW_MCP_NO_UPDATE_CHECK === '1' || env.PW_MCP_NO_UPDATE_CHECK === 'true') {
    return { state: 'skipped', current, reason: 'PW_MCP_NO_UPDATE_CHECK is set' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { state: 'unknown', current, reason: 'fetch is not available' };
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!res.ok) return { state: 'unknown', current, reason: `npm registry answered ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    const latest = typeof body.version === 'string' ? body.version : '';
    if (!/^\d+\.\d+\.\d+/.test(latest)) return { state: 'unknown', current, reason: 'npm registry gave no version' };
    const cmp = compareVersions(current, latest);
    return { state: cmp < 0 ? 'outdated' : cmp > 0 ? 'ahead' : 'current', current, latest };
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? 'npm registry did not answer in time' : (err as Error).message.split('\n')[0];
    return { state: 'unknown', current, reason: message };
  }
}

/**
 * How to upgrade, by the way this copy was installed. `npx -y
 * playwright-e2e-mcp` (npm 10, which ships with Node 22) checks the registry
 * on every launch and picks up a new release by itself, so restarting the MCP
 * client is enough there; a project or global install, a git clone or the
 * Docker image stays on its version until updated.
 */
export const UPGRADE_HINT =
  'restart your MCP client (npx -y playwright-e2e-mcp fetches the new version itself); ' +
  'project install: npm install -D playwright-e2e-mcp@latest · global: npm install -g playwright-e2e-mcp@latest · ' +
  'Docker: docker pull ghcr.io/xsignon-secure/playwright-e2e-mcp:latest · git clone: git pull && npm ci';
