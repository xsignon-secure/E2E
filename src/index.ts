#!/usr/bin/env node
/**
 * playwright-e2e-mcp entry point.
 *
 * When executed (npx playwright-e2e-mcp / the `bin` shim) it connects
 * the MCP server over stdio. When imported it only exposes the API, so
 * tests and tooling can construct a server without side effects.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger, createLogger } from './utils/logger.js';
import { SERVER_VERSION } from './server.js';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'ci') {
    const { runCi, CI_USAGE } = await import('./cli/ci.js');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(CI_USAGE);
      return;
    }
    process.exitCode = await runCi(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'init') {
    const { runInit, INIT_USAGE } = await import('./cli/init.js');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(INIT_USAGE);
      return;
    }
    process.exitCode = runInit(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'doctor') {
    const { runDoctor, DOCTOR_USAGE } = await import('./cli/doctor.js');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(DOCTOR_USAGE);
      return;
    }
    process.exitCode = await runDoctor(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'guard') {
    const { runGuard, GUARD_USAGE } = await import('./cli/guard.js');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(GUARD_USAGE);
      return;
    }
    process.exitCode = await runGuard(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'upload') {
    const { runUpload, UPLOAD_USAGE } = await import('./cli/upload.js');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(UPLOAD_USAGE);
      return;
    }
    process.exitCode = await runUpload(process.argv.slice(3));
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      [
        'playwright-e2e-mcp — MCP server for running and debugging Playwright tests',
        '',
        'Usage: playwright-e2e-mcp [--tools=<list>] [--version] [--help]',
        '       playwright-e2e-mcp ci [options]   run the suite and print a Markdown diagnosis (ci --help)',
        '       playwright-e2e-mcp init [options] add the server + agent skill to a project (init --help)',
        '       playwright-e2e-mcp doctor         check Node, Playwright, browsers, setup and updates (doctor --help)',
        '       playwright-e2e-mcp guard [options] fail CI when changed tests check less (guard --help)',
        '       playwright-e2e-mcp upload [options] send recorded runs to Pro Cloud (opt-in; upload --help)',
        '',
        'Connects over stdio (MCP). Configuration via environment:',
        '  PW_MCP_PROJECT_ROOT        default project root (default: cwd)',
        '  PW_MCP_TOOLS               tools to expose: names and/or profiles, comma separated',
        '                             (all | core | triage | inspect | author); same as --tools',
        '  PW_MCP_ALLOWED_ROOTS       extra roots callers may pass as projectRoot',
        '  PW_MCP_BLOCK_PRIVATE_URLS  1 = URL tools refuse private/loopback/metadata addresses',
        '  PW_MCP_PRO_KEY / PW_MCP_PRO_URL  optional Pro Cloud key and address; unset = no network calls',
        '  PW_MCP_LOGIN_ENV           extra variables save-login may type ({{env:NAME}}), comma separated',
        '  PW_MCP_PROTOCOL            legacy = do not offer the 2026-07-28 MCP revision',
        '  PW_MCP_SKILLS              0 = do not serve the bundled skill over the Skills extension',
        '  PW_MCP_NO_UPDATE_CHECK     1 = doctor does not ask npm whether a newer version is out',
        '  LOG_LEVEL / MCP_LOG_LEVEL  debug | info | warn | error | silent (default: info)',
        '  LOG_FORMAT / MCP_LOG_FORMAT  text | json (default: text)',
        '',
        'HTTP bridge only (api/mcp.ts, src/http.ts):',
        '  PW_MCP_HTTP_TOKEN          bearer token (16+ chars) that unlocks all tools',
        '  PW_MCP_ALLOWED_HOSTS       Host allowlist, comma separated (* = any)',
        '  PW_MCP_PASSTHROUGH_ENV     extra variables passed to test runs',
        '  PW_MCP_MAX_CHILDREN        concurrent runs (default: 4)',
        '',
      ].join('\n'),
    );
    return;
  }

  const toolsFlag = process.argv.find((arg) => arg.startsWith('--tools='));
  if (toolsFlag) process.env.PW_MCP_TOOLS = toolsFlag.slice('--tools='.length);

  const { startServer } = await import('./server.js');
  await startServer();
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const log = createLogger({ bindings: { name: 'playwright-e2e-mcp' } });
    log.error('server failed to start', { error: err });
    process.exit(1);
  });
}

export { createServer, startServer, resolveToolSelection, TOOL_PROFILES, SERVER_NAME, SERVER_VERSION } from './server.js';
export { createMcpHttpHandler, handleNodeRequest, MAX_BODY_BYTES } from './http.js';
export { logger };
