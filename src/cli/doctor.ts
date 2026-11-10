/**
 * `playwright-e2e-mcp doctor`: checks the things a first run usually trips
 * on and says how to fix each one: Node version, the Playwright config and
 * install, installed browsers, test files, and whether the server and the
 * agent skill are wired into the project's MCP clients.
 *
 * It only reads: nothing is installed or written.
 *
 * Exit codes: 0 nothing failed (warnings allowed), 1 a check failed,
 * 2 bad arguments.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { detectProject, findTestFiles } from '../utils/project-detector.js';
import { LAZY_PROFILE, SERVER_VERSION, TOOL_PROFILES, estimateToolTokens, resolveToolSelection } from '../server.js';
import { SERVER_NAME, SKILL_NAME } from './init.js';
import { checkForUpdate, UPGRADE_HINT, type UpdateCheckOptions } from '../utils/update-check.js';

export const DOCTOR_USAGE = [
  'Usage: playwright-e2e-mcp doctor [options]',
  '',
  'Checks Node, the Playwright config and install, browsers, test files and the',
  'MCP client setup, and says how to fix anything missing. Reads only.',
  '',
  '  --project-root <dir>   project directory (default: cwd)',
  '  --json                 print the checks as JSON',
  '  --offline              skip asking npm whether a newer version exists',
  '                         (also PW_MCP_NO_UPDATE_CHECK=1)',
  '',
].join('\n');

const REPO_URL = 'https://github.com/xsignon-secure/E2E';

/** Oldest Node major the server supports. */
export const MIN_NODE_MAJOR = 22;

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to run or change; present for warn and fail. */
  fix?: string;
}

export interface DoctorReport {
  version: string;
  projectRoot: string;
  checks: DoctorCheck[];
  ok: boolean;
}

/** Where each client keeps its project-scoped MCP config (see init). */
function clientConfigs(root: string, home: string): Array<{ client: string; file: string }> {
  return [
    { client: 'Claude Code', file: path.join(root, '.mcp.json') },
    { client: 'Cursor', file: path.join(root, '.cursor', 'mcp.json') },
    { client: 'VS Code', file: path.join(root, '.vscode', 'mcp.json') },
    { client: 'Gemini CLI', file: path.join(root, '.gemini', 'settings.json') },
    { client: 'Codex', file: path.join(root, '.codex', 'config.toml') },
    { client: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

function mentionsServer(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes(`"${SERVER_NAME}"`) || text.includes(`mcp_servers.${SERVER_NAME}`) || text.includes('playwright-e2e-mcp');
  } catch {
    return false;
  }
}

function nodeCheck(version = process.versions.node): DoctorCheck {
  const major = Number(version.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return { name: 'Node.js', status: 'ok', detail: `v${version}` };
  return {
    name: 'Node.js',
    status: 'fail',
    detail: `v${version} is older than the supported ${MIN_NODE_MAJOR}`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org)`,
  };
}

/** Each browser's install state, read through the project's own Playwright. */
function browserChecks(root: string, playwrightPackage: string): DoctorCheck[] {
  let pw: Record<string, { executablePath(): string } | undefined>;
  try {
    pw = createRequire(path.join(root, 'package.json'))(playwrightPackage) as typeof pw;
  } catch (err) {
    return [
      {
        name: 'Browsers',
        status: 'fail',
        detail: `could not load ${playwrightPackage}: ${(err as Error).message.split('\n')[0]}`,
        fix: 'Reinstall dependencies (npm install), then npx playwright install chromium',
      },
    ];
  }
  const installed: string[] = [];
  const missing: string[] = [];
  for (const name of ['chromium', 'firefox', 'webkit']) {
    let executable = '';
    try {
      executable = pw[name]?.executablePath() ?? '';
    } catch {
      executable = '';
    }
    (executable && existsSync(executable) ? installed : missing).push(name);
  }
  if (!installed.includes('chromium')) {
    return [
      {
        name: 'Browsers',
        status: 'fail',
        detail: installed.length ? `Chromium is missing (installed: ${installed.join(', ')})` : 'no browsers installed for this Playwright version',
        fix: 'npx playwright install chromium',
      },
    ];
  }
  return [{ name: 'Browsers', status: 'ok', detail: `installed: ${installed.join(', ')}${missing.length ? ` (not installed: ${missing.join(', ')})` : ''}` }];
}

/**
 * The running version against the latest on npm. A newer release is a
 * warning with the upgrade commands; an unreachable registry is not a
 * problem with the setup, so it stays `ok` and says it could not check.
 */
export async function versionCheck(options: UpdateCheckOptions = {}): Promise<DoctorCheck> {
  const status = await checkForUpdate(SERVER_VERSION, options);
  switch (status.state) {
    case 'outdated':
      return {
        name: 'Version',
        status: 'warn',
        detail: `${status.current} is running; ${status.latest} is out (release notes: ${REPO_URL}/releases/tag/v${status.latest})`,
        fix: UPGRADE_HINT,
      };
    case 'current':
      return { name: 'Version', status: 'ok', detail: `${status.current} (latest)` };
    case 'ahead':
      return { name: 'Version', status: 'ok', detail: `${status.current} (newer than npm's ${status.latest})` };
    default:
      return { name: 'Version', status: 'ok', detail: `${status.current} (did not check for updates: ${status.reason})` };
  }
}

/**
 * The tools setting a client config passes to the server: `--tools=<list>`
 * (or `"--tools", "<list>"` as two args) in its args or PW_MCP_TOOLS in its env (JSON or Codex TOML). Undefined when
 * the file has neither, so the server lists every tool.
 */
export function toolsSettingIn(text: string): string | undefined {
  const flag = /--tools(?:=|["']\s*,\s*["'])([^"'\s\]]+)/.exec(text);
  if (flag) return flag[1];
  const env = /["']?PW_MCP_TOOLS["']?\s*[:=]\s*["']([^"']*)["']/.exec(text);
  return env ? env[1] : undefined;
}

/**
 * Shows how many tools the server would expose and roughly how many tokens
 * their definitions cost the model per request (characters ÷ 4). The setting
 * comes from PW_MCP_TOOLS in this shell, else from the first client config
 * that sets one. When all tools are loaded, warns and suggests a profile.
 */
export function toolsCheck(toolsSpec = process.env.PW_MCP_TOOLS, source = 'PW_MCP_TOOLS'): DoctorCheck {
  const resolved = resolveToolSelection(toolsSpec);
  const total = TOOL_PROFILES.all.length;
  const exposed = resolved.tools ?? TOOL_PROFILES.all;
  const count = exposed.length;
  const tokens = estimateToolTokens(exposed);
  const tokenStr = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
  const from = toolsSpec?.trim() ? `; ${toolsSpec.trim()} from ${source}` : '';
  const lazy = resolved.lazy ? ' + load-tools' : '';
  const detail = `${count}/${total} tools${lazy} exposed (${tokenStr} tokens / request${from})`;
  if (resolved.unknown.length > 0) {
    return {
      name: 'Tools',
      status: 'warn',
      detail,
      fix: `Unknown tools or profiles ignored: ${resolved.unknown.join(', ')} (profiles: ${[...Object.keys(TOOL_PROFILES), LAZY_PROFILE].join(', ')})`,
    };
  }
  if (count >= total) {
    return {
      name: 'Tools',
      status: 'warn',
      detail,
      fix: 'Pass --tools=core (or --tools=auto) in your MCP client config to save tokens',
    };
  }
  return { name: 'Tools', status: 'ok', detail };
}

export interface DoctorOptions {
  /** Options for the npm version check; `{ offline: true }` skips it. */
  update?: UpdateCheckOptions;
}

export async function runDoctorChecks(projectRoot: string, home = os.homedir(), options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck(), await versionCheck(options.update)];
  const detection = await detectProject(projectRoot);
  const root = detection.root;

  if (!detection.configPath) {
    checks.push({
      name: 'Playwright config',
      status: 'fail',
      detail: `no playwright.config.* in ${projectRoot} or its parents`,
      fix: 'Run this in your Playwright project, or create one with npm init playwright@latest',
    });
  } else if (detection.configCandidates.length > 1) {
    checks.push({
      name: 'Playwright config',
      status: 'warn',
      detail: `${detection.configCandidates.length} configs in ${root}; tools use ${path.basename(detection.configPath)} unless told otherwise`,
      fix: 'Pass the config you mean to run-test, or keep one config per folder',
    });
  } else {
    checks.push({ name: 'Playwright config', status: 'ok', detail: path.relative(projectRoot, detection.configPath) || detection.configPath });
  }

  if (!detection.hasPlaywright || !detection.playwrightPackage) {
    checks.push({
      name: 'Playwright',
      status: 'fail',
      detail: 'neither @playwright/test nor playwright is installed in node_modules',
      fix: 'npm install -D @playwright/test',
    });
  } else {
    checks.push({ name: 'Playwright', status: 'ok', detail: `${detection.playwrightPackage} ${detection.playwrightVersion ?? '(unknown version)'}` });
    checks.push(...browserChecks(root, detection.playwrightPackage));
  }

  if (detection.configPath) {
    const files = await findTestFiles(root, { testDir: detection.testDir, limit: 1000 });
    checks.push(
      files.length
        ? { name: 'Test files', status: 'ok', detail: `${files.length}${files.length >= 1000 ? '+' : ''} found` }
        : {
            name: 'Test files',
            status: 'warn',
            detail: `none found under ${detection.testDir ? path.relative(root, detection.testDir) || '.' : 'the project'}`,
            fix: 'Add a *.spec.ts file, or ask your agent to write one with generate-e2e-test',
          },
    );
  }

  const configured = clientConfigs(projectRoot, home).filter(({ file }) => mentionsServer(file));
  checks.push(
    configured.length
      ? { name: 'MCP clients', status: 'ok', detail: `set up for ${configured.map((c) => c.client).join(', ')}` }
      : {
          name: 'MCP clients',
          status: 'warn',
          detail: 'no project config for Claude Code, Cursor, VS Code, Gemini CLI, Codex or Windsurf mentions the server',
          fix: 'npx -y playwright-e2e-mcp init (or add it in your client by hand; see the README)',
        },
  );

  const skill = [path.join(projectRoot, '.agents', 'skills', SKILL_NAME), path.join(projectRoot, '.claude', 'skills', SKILL_NAME)].find((dir) =>
    existsSync(path.join(dir, 'SKILL.md')),
  );
  checks.push(
    skill
      ? { name: 'Agent skill', status: 'ok', detail: path.relative(projectRoot, skill) }
      : { name: 'Agent skill', status: 'warn', detail: 'not installed in this project', fix: 'npx -y playwright-e2e-mcp init' },
  );

  // The server reads PW_MCP_TOOLS from its own environment, which the client
  // config sets; a value in this shell only matters for a server started here.
  const fromConfig = configured
    .map(({ file }) => {
      try {
        return { file, spec: toolsSettingIn(readFileSync(file, 'utf8')) };
      } catch {
        return { file, spec: undefined };
      }
    })
    .find((c) => c.spec !== undefined);
  checks.push(
    process.env.PW_MCP_TOOLS || !fromConfig
      ? toolsCheck()
      : toolsCheck(fromConfig.spec, path.relative(projectRoot, fromConfig.file) || fromConfig.file),
  );

  return { version: SERVER_VERSION, projectRoot, checks, ok: !checks.some((c) => c.status === 'fail') };
}

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

export function renderDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = [`playwright-e2e-mcp ${report.version} doctor: ${report.projectRoot}`, ''];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.fix) lines.push(`  ${' '.repeat(width)}  fix: ${check.fix}`);
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const warned = report.checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    failed
      ? `${failed} problem${failed === 1 ? '' : 's'} to fix before the tools can run your tests.`
      : warned
        ? `Ready, with ${warned} suggestion${warned === 1 ? '' : 's'} above.`
        : 'Everything is ready.',
  );
  // Only on a working setup: asking for a star while the tools can't run is no help to anyone.
  if (!failed) lines.push('', `Like it? A star helps other Playwright users find it: ${REPO_URL}`);
  return `${lines.join('\n')}\n`;
}

export async function runDoctor(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  let values: { 'project-root'?: string; json?: boolean; offline?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: { 'project-root': { type: 'string' }, json: { type: 'boolean' }, offline: { type: 'boolean' } },
    }));
  } catch (err) {
    out(`doctor: ${(err as Error).message}\n\n${DOCTOR_USAGE}`);
    return 2;
  }
  const report = await runDoctorChecks(path.resolve(values['project-root'] ?? '.'), os.homedir(), { update: { offline: values.offline } });
  out(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report));
  return report.ok ? 0 : 1;
}
