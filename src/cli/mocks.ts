/**
 * `playwright-e2e-mcp mocks`: check-mocks as a CI step. Calls each mocked
 * GET endpoint on a live server (a preview or staging deploy) and fails the
 * job when a mock no longer matches the API's JSON shape.
 *
 * Exit codes: 0 OK (or nothing compared), 1 drift, 2 bad arguments.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkProjectMocks, renderMockReport } from '../tools/check-mocks.js';

export const MOCKS_USAGE = [
  'Usage: playwright-e2e-mcp mocks [options]',
  '',
  'Finds route.fulfill JSON mocks and routeFromHAR files in the tests, GETs each mocked',
  'endpoint on the live server and fails when the API no longer has a field the mock',
  'relies on, changed a type, now returns null or removed the endpoint.',
  '',
  '  --base-url <url>        live server for relative mock URLs (default: use.baseURL in the config)',
  '  --map <pattern=url>     real URL for a wildcard or regex mock (repeatable)',
  '  --header <name:value>   header for the live calls, e.g. "Authorization: Bearer $TOKEN" (repeatable)',
  '  --project-root <dir>    project directory (default: cwd)',
  '  --filter <text>         only test files whose path contains this text',
  '  --json                  print the result as JSON',
  '',
  'Exit codes: 0 OK, 1 drift, 2 bad arguments.',
  '',
].join('\n');

export async function runMocks(argv: string[]): Promise<number> {
  let values: { 'base-url'?: string; map?: string[]; header?: string[]; 'project-root'?: string; filter?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'base-url': { type: 'string' },
        map: { type: 'string', multiple: true },
        header: { type: 'string', multiple: true },
        'project-root': { type: 'string' },
        filter: { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${MOCKS_USAGE}`);
    return 2;
  }
  const urls: Record<string, string> = {};
  for (const entry of values.map ?? []) {
    const at = entry.lastIndexOf('=');
    if (at <= 0) {
      process.stderr.write(`mocks: --map needs pattern=url, got "${entry}"\n`);
      return 2;
    }
    urls[entry.slice(0, at)] = entry.slice(at + 1);
  }
  // CLI headers come from the shell or CI secrets, so they are used as given.
  const headers: Record<string, string> = {};
  for (const entry of values.header ?? []) {
    const at = entry.indexOf(':');
    if (at <= 0) {
      process.stderr.write(`mocks: --header needs name:value\n`);
      return 2;
    }
    headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  const root = path.resolve(values['project-root'] ?? process.cwd()).replace(/\\/g, '/');
  try {
    const { checks, baseUrl, filesScanned } = await checkProjectMocks(root, { baseUrl: values['base-url'], urls, filter: values.filter, rawHeaders: headers });
    const report = renderMockReport(checks, baseUrl, filesScanned);
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ status: report.status, ok: report.status !== 'DRIFT', checks: checks.map((c) => ({ file: c.mock.file, line: c.mock.line, pattern: c.mock.pattern, url: c.url, skipped: c.skipped, findings: c.findings })) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${report.text}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try {
          appendFileSync(summary, `${report.text}\n`);
        } catch {
          // The job summary is a nicety; the exit code is what matters.
        }
      }
    }
    return report.status === 'DRIFT' ? 1 : 0;
  } catch (error) {
    const err = error as Error & { hint?: string };
    process.stderr.write(`mocks: ${err.message}${err.hint ? `\n${err.hint}` : ''}\n`);
    return 2;
  }
}
