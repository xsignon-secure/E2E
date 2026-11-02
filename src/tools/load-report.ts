/**
 * Tool 14 — load-report: bring a run that happened elsewhere (a CI job, a
 * teammate's machine) into the same diagnosis loop as a local run.
 *
 * It reads a Playwright JSON report (or merges a folder of blob reports
 * from sharded jobs), rebases the CI machine's absolute paths onto the
 * local checkout, finds the trace archives wherever the job's
 * test-results artifact was unpacked, and makes the result the "last run",
 * so get-failure, suggest-fix and diagnose-flaky work on it exactly as on
 * a run-test result. The run is recorded in the history with the commit
 * it tested, so analyze-history covers CI as well.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { GitInfo, RunTestResult, ToolContext, ToolResponse } from '../types/index.js';
import { parseReportJson } from '../utils/report-parser.js';
import { childEnv, resolvePlaywrightCli, runProcess } from '../utils/playwright-runner.js';
import { recordRun } from '../utils/run-history.js';
import { serverlessChromiumEnabled } from '../utils/serverless-chromium.js';
import { fetchCiRun, findReport, parseCiRunRef } from '../utils/ci-artifacts.js';
import type { FetchedRun } from '../utils/ci-artifacts.js';
import {
  assertRealPathInside,
  normalizePath,
  relativeToRoot,
  resolvePath,
  sanitizeUserPath,
  tempFilePath,
  toNativePath,
} from '../utils/path-utils.js';
import { guard, resolveProjectRoot, toolText } from './shared.js';
import { renderRunResult } from './run-test.js';

const MAX_REPORT_BYTES = 200_000_000;

const loadReportInput = z.object({
  report: z
    .string()
    .describe('JSON report or blob-report folder inside the project, or a GitHub Actions run / GitLab job URL (needs GITHUB_TOKEN / GITLAB_TOKEN)'),
  traceDirs: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Folders inside the project where the job's test-results artifact was unpacked (default: the report's folder and its parent)"),
  commit: z.string().max(64).optional().describe('Commit the run tested (default: read from the report metadata)'),
  branch: z.string().max(200).optional(),
  record: z.boolean().optional().describe('Add the run to the local history for analyze-history (default true)'),
  projectRoot: z.string().optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional().describe('Limit for merging blob reports (default 120000)'),
});

export type LoadReportInput = z.infer<typeof loadReportInput>;
export const loadReportSchema = loadReportInput;

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}

/** Merge blob reports with the project's Playwright into one JSON report. */
async function mergeBlobReports(dir: string, root: string, ctx: ToolContext, timeoutMs: number): Promise<string> {
  const entries = await readdir(toNativePath(dir));
  if (!entries.some((name) => name.endsWith('.zip'))) {
    throw new PlaywrightMcpError(`No blob reports (*.zip) in ${relativeToRoot(root, dir)}`, 'REPORT_MISSING', {
      hint: 'Point `report` at the JSON report file, or at the folder holding the blob-report zips from every shard.',
    });
  }
  const cli = await resolvePlaywrightCli(root);
  if (!cli) {
    throw new PlaywrightMcpError('Playwright is not installed in this project', 'NO_PLAYWRIGHT', {
      hint: 'Merging blob reports needs the project\'s Playwright: npm install -D @playwright/test',
    });
  }
  const out = tempFilePath('pw-merged', '.json');
  const outcome = await runProcess(process.execPath, [cli, 'merge-reports', '--reporter=json', toNativePath(dir)], {
    cwd: root,
    env: childEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: out, FORCE_COLOR: '0' }),
    timeoutMs,
    signal: ctx.signal,
  });
  const raw = await readFile(out, 'utf8').catch(() => null);
  await rm(out, { force: true }).catch(() => undefined);
  if (raw === null) {
    throw new PlaywrightMcpError(
      `playwright merge-reports produced no report${outcome.timedOut ? ' (timed out)' : ''}`,
      outcome.timedOut ? 'TIMEOUT' : 'REPORT_MISSING',
      { hint: 'Check that every zip is a blob report from the same Playwright version as this project.', details: outcome.stderr.slice(-2_000) },
    );
  }
  return raw;
}

export const loadReportTool = {
  name: 'load-report',
  description:
    "Load a Playwright run that happened elsewhere (a CI job's JSON report, a folder of blob reports from shards, or a GitHub Actions / GitLab CI run URL) so get-failure, suggest-fix and diagnose-flaky work on it like a local run. CI paths are mapped onto this checkout and traces are found in the unpacked test-results artifact; the run is recorded in the history with its commit.",
  inputSchema: loadReportSchema,
  handler: async (args: LoadReportInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('load-report', async () => {
      if (ctx.restricted) {
        throw new PlaywrightMcpError('load-report is not available on this server', 'INVALID_PATH', {
          hint: 'This endpoint does not read files from the project.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      let fetched: FetchedRun | undefined;
      let reportArg = args.report.trim();
      const ciRef = parseCiRunRef(reportArg);
      if (ciRef) {
        if (serverlessChromiumEnabled()) {
          throw new PlaywrightMcpError('Loading a CI run by URL is not available on this server', 'INVALID_INPUT', {
            hint: 'Run playwright-e2e-mcp locally (npx playwright-e2e-mcp) to download CI artifacts into your checkout.',
          });
        }
        fetched = await fetchCiRun(ciRef, root, ctx.signal);
        const found = await findReport(fetched.dir);
        if (!found) {
          throw new PlaywrightMcpError(`No Playwright report in the run's artifacts (${fetched.artifacts.join(', ')})`, 'REPORT_MISSING', {
            hint: 'Add the json reporter in CI (reporter: [["json", { outputFile: "results.json" }]]) or upload blob-report/, and upload it with the test-results/ folder.',
          });
        }
        reportArg = found;
      } else if (/^(https?|github|gitlab):\/\//i.test(reportArg)) {
        throw new PlaywrightMcpError('Unrecognised CI URL', 'INVALID_INPUT', {
          hint: 'Pass a GitHub Actions run URL (…/actions/runs/<id>) or a GitLab job URL (…/-/jobs/<id>), or a report path inside the project.',
        });
      }
      const reportPath = normalizePath(sanitizeUserPath(reportArg, root));
      await assertRealPathInside(reportPath, root);
      const info = await stat(toNativePath(reportPath)).catch(() => null);
      if (!info) {
        throw new PlaywrightMcpError(`Report not found: ${relativeToRoot(root, reportPath)}`, 'REPORT_MISSING', {
          hint: 'Download the CI artifact into the project first, e.g. `gh run download <run-id> -n playwright-report -D ci-artifacts`.',
        });
      }

      let raw: string;
      let source: string;
      if (info.isDirectory()) {
        raw = await mergeBlobReports(reportPath, root, ctx, args.timeoutMs ?? 120_000);
        source = `merged blob reports in \`${relativeToRoot(root, reportPath)}\``;
      } else {
        if (info.size > MAX_REPORT_BYTES) {
          throw new PlaywrightMcpError(`Report is too large (${Math.round(info.size / 1_000_000)} MB)`, 'INVALID_PATH');
        }
        raw = await readFile(toNativePath(reportPath), 'utf8');
        source = `\`${relativeToRoot(root, reportPath)}\``;
      }
      if (fetched) source += ` (downloaded from ${fetched.url || 'CI'}: ${fetched.artifacts.join(', ')})`;

      const traceDirs: string[] = [];
      for (const dir of args.traceDirs ?? (fetched ? [fetched.dir] : [parentOf(reportPath), parentOf(parentOf(reportPath))])) {
        const resolved = normalizePath(args.traceDirs ? sanitizeUserPath(dir, root) : resolvePath(root, dir));
        try {
          await assertRealPathInside(resolved, root);
          traceDirs.push(resolved);
        } catch {
          if (args.traceDirs) throw new PlaywrightMcpError(`traceDirs entry is outside the project: ${dir}`, 'INVALID_PATH');
        }
      }

      const parsed = parseReportJson(raw, root, undefined, { traceDirs });
      if (parsed.parseError) {
        throw new PlaywrightMcpError(parsed.parseError, 'REPORT_MISSING', {
          hint: 'Pass the file written by the json reporter (`reporter: [["json", { outputFile: "results.json" }]]`), or a folder of blob-report zips.',
        });
      }

      const git: GitInfo = {
        ...parsed.git,
        ...(fetched?.commit ? { commit: fetched.commit } : {}),
        ...(fetched?.branch ? { branch: fetched.branch } : {}),
        ...(fetched?.url ? { buildUrl: fetched.url } : {}),
        ...(args.commit ? { commit: args.commit.trim() } : {}),
        ...(args.branch ? { branch: args.branch.trim() } : {}),
      };
      const stats = parsed.stats;
      const result: RunTestResult = {
        ok: (stats?.unexpected ?? parsed.failures.length) === 0,
        outcomes: parsed.outcomes,
        exitCode: null,
        signalName: null,
        durationMs: stats?.duration ?? 0,
        timedOut: false,
        killed: false,
        partial: false,
        stats,
        failures: parsed.failures,
        failuresTruncated: parsed.failuresTruncated,
        stdoutTail: '',
        stderrTail: '',
        truncatedOutput: false,
        reportPath: info.isDirectory() ? undefined : toNativePath(reportPath),
        command: `load-report ${relativeToRoot(root, reportPath)}`,
        imported: { reportPath, traceDirs, git: Object.keys(git).length > 0 ? git : undefined },
      };
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });

      let recorded = false;
      if (args.record !== false) {
        // An imported run records the commit it tested, never this checkout's.
        recorded = await recordRun(root, result, 'load-report', { git }).catch(() => false);
      }

      const withTrace = parsed.failures.filter((f) => f.tracePath).length;
      const lines = [
        renderRunResult(result, root).replace('## Playwright run —', '## Imported run —'),
        '',
        `**Source:** ${source}${git.commit ? ` · commit \`${git.commit.slice(0, 8)}\`` : ''}${git.branch ? ` on \`${git.branch}\`` : ''}${git.buildUrl ? ` · [build](${git.buildUrl})` : ''}`,
      ];
      if (parsed.failures.length > 0) {
        lines.push(
          withTrace === parsed.failures.length
            ? `**Traces:** found for all ${withTrace} failure(s), so get-failure shows the DOM, requests and console at failure.`
            : `**Traces:** found for ${withTrace} of ${parsed.failures.length} failure(s). Unpack the job's test-results artifact into the project and pass its folder as \`traceDirs\` to see the DOM at failure.`,
        );
      }
      lines.push(
        recorded ? '**History:** recorded; `analyze-history` now includes this run.' : '**History:** not recorded.',
        '',
        '> This run is now the last run: **get-failure**, **suggest-fix** (which re-runs the fix locally) and **diagnose-flaky** work on it.',
      );
      return toolText(lines.join('\n'));
    }),
};
