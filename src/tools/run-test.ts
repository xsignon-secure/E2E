/**
 * Tool 1 — run-test: execute Playwright tests and report structured
 * results (stats, failures, diagnostics, hints).
 */

import { quarantineLines, readQuarantine, splitFailures } from '../utils/quarantine.js';
import type { QuarantineSplit } from '../utils/quarantine.js';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { RunTestOptions, RunTestResult, TestFailure, ToolContext, ToolResponse } from '../types/index.js';
import { detectProject, missingPlaywrightMessage } from '../utils/project-detector.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectPytestProject } from '../utils/pytest-runner.js';
import { normalizePath, relativeToRoot } from '../utils/path-utils.js';
import { recordRun } from '../utils/run-history.js';
import { startBackgroundRun } from '../utils/run-registry.js';
import { runData } from './structured.js';
import {
  codeFence,
  clipLines,
  formatDuration,
  guard,
  markdownCell,
  renderFailure,
  resolveConfigSelection,
  resolveProjectRoot,
  sanitizeTestPathArgument,
  testPathExists,
  toolError,
  toolText,
} from './shared.js';

const runTestInput = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe('Project directory; defaults to the server working directory'),
  testFiles: z
    .array(z.string())
    .optional()
    .describe(
      'Test files/directories relative to the project root; "file:line" is supported. Omit to run the whole suite.',
    ),
  grep: z.string().optional().describe('Only run tests whose title matches this regex'),
  browser: z
    .enum(['chromium', 'firefox', 'webkit'])
    .optional()
    .describe('Playwright project name to run (matched against playwright.config projects)'),
  headed: z.boolean().optional().describe('Run with a visible browser window'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Hard wall-clock limit for the whole run; the process tree is killed past it (default 120000)'),
  testTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Per-test timeout passed to Playwright'),
  workers: z.number().int().min(1).max(64).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryOnFailure: z
    .boolean()
    .optional()
    .describe('Auto retry failing tests once before reporting failure (default true; ignored when retries is set)'),
  lastFailed: z
    .boolean()
    .optional()
    .describe('Only re-run tests that failed in the previous run (Playwright --last-failed) — the fast fix → re-run loop'),
  config: z
    .string()
    .optional()
    .describe('playwright.config path or 1-based index when the project has several configs'),
  args: z
    .array(z.string())
    .optional()
    .describe('Extra Playwright flags from an allowlist, as --flag or --flag=value (e.g. --repeat-each=3, --shard=1/2, --trace=on)'),
  background: z
    .boolean()
    .optional()
    .describe('Return a run id at once; poll get-run-status'),
});

export type RunTestInput = z.infer<typeof runTestInput>;
export const runTestSchema = runTestInput;

export interface FailureCluster {
  kind: string;
  /** First line of the shared error, as shown. */
  headline: string;
  /** Indexes into result.failures (0-based), first one is the representative. */
  indexes: number[];
}

/** First error line with digits folded; ANSI codes and stray whitespace removed. */
function clusterKey(failure: TestFailure): string {
  const first = (failure.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim() !== '') ?? '';
  return `${failure.failureKind}|${first.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/**
 * Group failures that share one cause (same kind and same first error line,
 * numbers aside): a dead server or one drifted shared component fails many
 * tests the same way, and is fixed once.
 */
export function clusterFailures(failures: TestFailure[]): FailureCluster[] {
  const byKey = new Map<string, FailureCluster>();
  failures.forEach((failure, i) => {
    const key = clusterKey(failure);
    const cluster = byKey.get(key);
    if (cluster) cluster.indexes.push(i);
    else {
      const headline = (failure.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
      byKey.set(key, { kind: failure.failureKind, headline, indexes: [i] });
    }
  });
  return [...byKey.values()];
}

function renderFailures(failures: TestFailure[]): string[] {
  const clusters = clusterFailures(failures);
  const shared = clusters.filter((c) => c.indexes.length > 1);
  if (shared.length === 0) {
    return failures.flatMap((failure, i) => [renderFailure(failure, i, failures.length), '']);
  }
  const lines = [
    `**${clusters.length} distinct cause${clusters.length === 1 ? '' : 's'}** for ${failures.length} failures; tests that fail the same way are shown once, under the first of them. Fix the cause, then re-run with \`lastFailed: true\`.`,
    '',
  ];
  for (const cluster of clusters) {
    const [first, ...rest] = cluster.indexes;
    if (rest.length > 0) lines.push(`#### Same cause in ${cluster.indexes.length} tests: ${markdownCell(clipLines(cluster.headline, 1, 140))}`, '');
    lines.push(renderFailure(failures[first], first, failures.length), '');
    if (rest.length > 0) {
      for (const i of rest) {
        const f = failures[i];
        lines.push(`- ${i + 1} of ${failures.length}. ${f.title} · \`${f.file}${f.line ? `:${f.line}` : ''}\``);
      }
      lines.push('');
    }
  }
  return lines;
}

/**
 * Did the run pass once quarantined failures are set aside? Only test
 * failures can be quarantined: a crash, a timeout or a config error still
 * fails the run.
 */
export function passesWithQuarantine(result: RunTestResult, split: QuarantineSplit | undefined): boolean {
  if (result.ok) return true;
  if (!split || split.quarantined.length === 0 || split.blocking.length > 0) return false;
  return !result.timedOut && !result.errorKind && !result.partial && !result.failuresTruncated;
}

/** Split a run's failures by the project's quarantine list; undefined when there is none. */
export async function quarantineSplit(root: string, result: RunTestResult): Promise<QuarantineSplit | undefined> {
  if (result.failures.length === 0) return undefined;
  const list = await readQuarantine(root).catch(() => undefined);
  if (!list || list.entries.length === 0) return undefined;
  return splitFailures(result.failures, list);
}

export function renderRunResult(result: RunTestResult, root: string, split?: QuarantineSplit): string {
  const flakyCount = result.stats?.flaky ?? 0;
  const status = result.ok
    ? flakyCount > 0
      ? `✅ PASSED (${flakyCount} flaky)`
      : '✅ PASSED'
    : passesWithQuarantine(result, split)
      ? `✅ PASSED (${split!.quarantined.length} quarantined failure${split!.quarantined.length === 1 ? '' : 's'})`
      : result.timedOut
        ? '⏱️ KILLED (timeout)'
        : '❌ FAILED';
  const lines: string[] = [`## Playwright run — ${status}`, ''];
  lines.push(`**Command:** \`${result.command}\``);

  const meta = [
    `duration ${formatDuration(result.durationMs)}`,
    `exit ${result.exitCode ?? '—'}`,
  ];
  if (result.configPath) meta.push(`config \`${relativeToRoot(root, result.configPath)}\``);
  if (result.autoRetry) meta.push('auto retry ×1');
  if (result.lastFailed) meta.push('failed tests only (--last-failed)');
  if (result.timedOut) meta.push('killed at wrapper timeout');
  if (result.partial) meta.push('partial results');
  lines.push(`**${meta.join(' · ')}**`, '');

  if (result.stats) {
    const s = result.stats;
    lines.push(
      '| passed | failed | flaky | skipped | duration |',
      '| ---: | ---: | ---: | ---: | ---: |',
      `| ${s.expected} | ${s.unexpected} | ${s.flaky} | ${s.skipped} | ${formatDuration(s.duration)} |`,
      '',
    );
  } else {
    lines.push('_No test statistics were reported._', '');
  }

  if (flakyCount > 0) {
    lines.push(
      `> ⚠️ **${flakyCount} flaky test(s)** failed first but passed on the automatic retry. Re-run to confirm they are stable before trusting them.`,
      '',
    );
  }

  if (split) lines.push(...quarantineLines(split));

  if (result.failures.length > 0) {
    const more = result.failuresTruncated ? ' (showing the first ones)' : '';
    lines.push(`### ❌ ${result.failures.length} failing test(s)${more}`, '');
    lines.push(...renderFailures(result.failures));
    lines.push(
      '> Next: call **get-failure** with `index` to get the full stack, code frame and a suggested fix for one failure.',
      '',
    );
  }

  if (result.errorKind) {
    lines.push(`### ⚠️ ${result.errorKind}`, '', result.errorMessage ?? '', '');
    if (result.hint) lines.push(result.hint, '');
  } else if (result.hint && result.hint.trim() !== '') {
    lines.push(`> ${result.hint.replace(/\n/g, '\n> ')}`, '');
  }

  if (!result.ok && result.stderrTail.trim() !== '') {
    lines.push(
      '<details><summary>stderr tail</summary>',
      '',
      codeFence(clipLines(result.stderrTail, 40), 'text'),
      '',
      '</details>',
      '',
    );
  }
  return lines.join('\n');
}

export const runTestTool = {
  name: 'run-test',
  description:
    'Run the project\'s Playwright tests: stats plus each failure\'s file:line, kind and message. Diagnoses missing installs, dead dev servers, syntax errors, crashes and timeouts (kills the tree, keeps partial results). Reports progress; background: true returns a run id for long suites. Runs are recorded for analyze-history.',
  inputSchema: runTestSchema,
  handler: async (args: RunTestInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('run-test', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const detection = await detectProject(root);

      if (!detection.hasPlaywright && !(await detectPytestProject(root))) {
        const { message, hint } = missingPlaywrightMessage(detection);
        return toolError('NO_PLAYWRIGHT', message, hint);
      }

      const configPath = resolveConfigSelection(detection, args.config);

      const sanitized: string[] = [];
      const missing: string[] = [];
      for (const raw of args.testFiles ?? []) {
        const absolute = sanitizeTestPathArgument(raw, root);
        sanitized.push(absolute);
        if (!(await testPathExists(absolute, root))) missing.push(raw);
      }
      if (missing.length > 0) {
        throw new PlaywrightMcpError(`Test path(s) not found: ${missing.join(', ')}`, 'INVALID_PATH', {
          hint: `Paths resolve inside ${normalizePath(root)}. Call list-tests to see the available tests.`,
        });
      }

      const options: RunTestOptions = {
        projectRoot: root,
        configPath,
        testFiles: sanitized,
        grep: args.grep,
        browser: args.browser,
        headed: args.headed,
        timeoutMs: args.timeoutMs,
        testTimeoutMs: args.testTimeoutMs,
        workers: args.workers,
        retries: args.retries,
        retryOnFailure: args.retryOnFailure,
        lastFailed: args.lastFailed,
        extraArgs: args.args,
        signal: ctx.signal,
      };

      if (args.background) {
        const { signal: _signal, ...rest } = options;
        const label = sanitized.length > 0 ? sanitized.map((f) => relativeToRoot(root, f)).join(', ') : 'whole suite';
        const run = startBackgroundRun(rest, label, async (result) => {
          ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
          await recordRun(root, result, 'run-test');
        });
        return toolText(
          [
            `## ▶️ Run started in the background — \`${run.id}\``,
            '',
            `**Tests:** ${label}`,
            '',
            `> Next: call **get-run-status** with \`runId: "${run.id}"\` (add \`waitSeconds\` to wait for it). The result also becomes the last run for **get-failure** and **suggest-fix** when it finishes.`,
          ].join('\n'),
          { runId: run.id, status: 'running' },
        );
      }

      const result = await runTests({
        ...options,
        onProgress: ctx.progress
          ? (p) => ctx.progress?.(p.done, p.total, `${p.done}${p.total ? `/${p.total}` : ''} tests done${p.failed ? `, ${p.failed} failed` : ''}${p.last ? ` · ${p.last}` : ''}`)
          : undefined,
      });
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
      await recordRun(root, result, 'run-test').catch((err) => ctx.logger.warn('could not record run history', { error: err }));
      ctx.logger.info('run-test finished', {
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        failures: result.failures.length,
      });
      const split = await quarantineSplit(root, result);
      const passed = passesWithQuarantine(result, split);
      return toolText(renderRunResult(result, root, split), {
        ok: passed,
        run: { ...runData(result), ...(split?.quarantined.length ? { quarantined: split.quarantined.length } : {}) },
      });
    }),
};
