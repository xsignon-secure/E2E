/**
 * Tool 8 — diagnose-flaky: run failing tests several times with retries
 * disabled and decide, per test and from evidence, whether each one is
 * genuinely flaky, consistently broken, or no longer reproducible.
 *
 * By default all repetitions run in one Playwright process
 * (`--repeat-each`), which skips N-1 process and browser start-ups. A
 * small attempts reporter records every repetition, since the JSON report
 * keeps only one result per test. `isolate` adds a second pass with one
 * worker so failures caused by parallelism (shared state, test-order
 * coupling, contention) are told apart from flakiness inside the test.
 * `order` (Playwright 1.64+) runs the target files in several random orders
 * with one worker and replays a failing order, which finds tests that pass
 * or fail depending on what ran before them, and names the likely culprit.
 *
 * The verdict logic is pure functions (exported for unit tests).
 */

import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type {
  RunTestResult,
  TestAttempt,
  TestFailure,
  TestOutcome,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { detectProject, missingPlaywrightMessage } from '../utils/project-detector.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectPytestProject, resolvePython } from '../utils/pytest-runner.js';
import { childEnv, runProcess } from '../utils/playwright-runner.js';
import { relativeToRoot } from '../utils/path-utils.js';
import { recordRun } from '../utils/run-history.js';
import { classifyFailure } from '../utils/report-parser.js';
import { readFailureTrace } from '../utils/trace-reader.js';
import { renderHydration } from './get-failure.js';
import {
  clipLines,
  formatDuration,
  guard,
  markdownCell,
  resolveConfigSelection,
  resolveProjectRoot,
  sanitizeTestPathArgument,
  testPathExists,
  toolError,
  toolText,
} from './shared.js';

const diagnoseFlakyInput = z.object({
  projectRoot: z.string().optional().describe('Project directory; defaults to the server working directory'),
  testFiles: z
    .array(z.string())
    .optional()
    .describe(
      'Tests to diagnose ("file:line" supported). Defaults to the tests that failed in the most recent run.',
    ),
  runs: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .describe('How many times to run the tests (default 3)'),
  browser: z
    .enum(['chromium', 'firefox', 'webkit'])
    .optional()
    .describe('Playwright project name to run'),
  headed: z.boolean().optional().describe('Run with a visible browser window'),
  workers: z.number().int().min(1).max(64).optional(),
  isolate: z
    .boolean()
    .optional()
    .describe(
      'Also tell parallelism bugs from real flakiness: repeat in parallel (fully parallel, `workers` default 4), then repeat the failing tests with one worker',
    ),
  order: z
    .boolean()
    .optional()
    .describe('Also run the target files in `runs` random orders (Playwright 1.64+ --shuffle, one worker) to find tests that depend on what ran before them; returns the seed that reproduces it and the likely culprit test'),
  separateProcesses: z
    .boolean()
    .optional()
    .describe('Start a fresh Playwright process per run instead of one --repeat-each process (slower; use when the flake depends on global setup or a cold start)'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Hard wall-clock limit per run (default 120000); one --repeat-each process gets this × runs'),
  config: z
    .string()
    .optional()
    .describe('playwright.config path or 1-based index when the project has several configs'),
});

export type DiagnoseFlakyInput = z.infer<typeof diagnoseFlakyInput>;
export const diagnoseFlakySchema = diagnoseFlakyInput;

/* ------------------------------------------------------------------ */
/* Pure verdict logic (unit-tested)                                    */
/* ------------------------------------------------------------------ */

export interface FlakyRunOutcome {
  ok: boolean;
  durationMs: number;
  /** Normalized error signature of the first failure, when one occurred. */
  signature?: string;
  /** First line of the failure message, for display. */
  headline?: string;
  /** No tests executed (bad filter, empty suite, crashed reporter). */
  noTests?: boolean;
  /** Run-level error (timeout, spawn failure…) rather than a test failure. */
  errorKind?: string;
}

export type FlakyVerdict =
  | 'NOT REPRODUCING'
  | 'FLAKY'
  | 'CONSISTENTLY FAILING'
  | 'NO TESTS RAN';

export interface FlakySummary {
  verdict: FlakyVerdict;
  passed: number;
  failed: number;
  /** Number of distinct normalized error signatures across failed runs. */
  distinctSignatures: number;
  /** True when every failed run failed with the same signature. */
  sameError: boolean;
}

/**
 * Normalize a failure message into a comparable signature: first line,
 * lowercased, digits folded, whitespace collapsed.
 */
export function failureSignature(failure: TestFailure | undefined): string | undefined {
  if (!failure) return undefined;
  const firstLine = (failure.message ?? '').split('\n')[0] ?? '';
  const normalized = firstLine
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return normalized === '' ? undefined : normalized;
}

/** Decide the verdict from the per-run outcomes. */
export function summarizeFlaky(runs: FlakyRunOutcome[]): FlakySummary {
  const ranAnything = runs.some((r) => !r.noTests);
  const passed = runs.filter((r) => r.ok && !r.noTests).length;
  const failed = runs.filter((r) => !r.ok && !r.noTests).length;
  const signatures = new Set(runs.map((r) => r.signature).filter((s): s is string => s !== undefined));

  let verdict: FlakyVerdict;
  if (!ranAnything) verdict = 'NO TESTS RAN';
  else if (failed === 0) verdict = 'NOT REPRODUCING';
  else if (passed === 0) verdict = 'CONSISTENTLY FAILING';
  else verdict = 'FLAKY';

  return {
    verdict,
    passed,
    failed,
    distinctSignatures: signatures.size,
    sameError: signatures.size <= 1,
  };
}

/** Every attempt of one test, in the order they finished. */
export interface TestEvidence {
  file: string;
  line?: number;
  title: string;
  project?: string;
  outcomes: FlakyRunOutcome[];
}

/** `file:line` (or just the file) — what run-test and diagnose-flaky accept. */
export function evidenceTarget(evidence: Pick<TestEvidence, 'file' | 'line'>): string {
  return evidence.line ? `${evidence.file}:${evidence.line}` : evidence.file;
}

/** Group reporter attempts per test (file, line, title, project). */
export function groupAttempts(attempts: TestAttempt[]): TestEvidence[] {
  const byKey = new Map<string, TestEvidence>();
  for (const attempt of attempts) {
    const key = [attempt.file, attempt.line ?? '', attempt.title, attempt.project ?? ''].join('\u0000');
    let evidence = byKey.get(key);
    if (!evidence) {
      evidence = { file: attempt.file, line: attempt.line, title: attempt.title, project: attempt.project, outcomes: [] };
      byKey.set(key, evidence);
    }
    const skipped = attempt.status === 'skipped';
    const ok = attempt.status === (attempt.expectedStatus ?? 'passed');
    evidence.outcomes.push({
      ok: ok && !skipped,
      durationMs: attempt.durationMs,
      signature: ok ? undefined : failureSignature({ message: attempt.message ?? attempt.status } as TestFailure),
      headline: ok ? undefined : (attempt.message ?? attempt.status),
      noTests: skipped,
    });
  }
  return [...byKey.values()];
}

export type IsolationReading =
  | 'PARALLEL ONLY'
  | 'FLAKY ALONE TOO'
  | 'FAILS EITHER WAY'
  | 'NOT REPRODUCING';

/**
 * Compare a test's parallel evidence with its one-worker evidence.
 * `isolated` is undefined when the test passed every parallel attempt and
 * was therefore not re-run.
 */
export function isolationReading(parallel: FlakySummary, isolated: FlakySummary | undefined): IsolationReading {
  if (parallel.failed === 0 || !isolated) return 'NOT REPRODUCING';
  if (isolated.failed === 0) return 'PARALLEL ONLY';
  if (isolated.passed === 0) return 'FAILS EITHER WAY';
  return 'FLAKY ALONE TOO';
}

/* ------------------------------------------------------------------ */
/* Test order (shuffle)                                                */
/* ------------------------------------------------------------------ */

/** True when this Playwright version has `--shuffle` (1.64+). */
export function supportsShuffle(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= 64);
}

/** One shuffled run: its seed and the attempts in execution order (one worker). */
export interface OrderRun {
  seed: string;
  attempts: TestAttempt[];
}

export type OrderReading = 'ORDER DEPENDENT' | 'FLAKY IN ANY ORDER' | 'FAILS IN EVERY ORDER' | 'PASSES IN EVERY ORDER';

export interface OrderFinding {
  file: string;
  line?: number;
  title: string;
  project?: string;
  passedSeeds: string[];
  failedSeeds: string[];
  /** The failing seed replayed to confirm, and whether it failed again. */
  replay?: { seed: string; failedAgain: boolean };
  reading: OrderReading;
  /** Tests that ran before this one in every failing order but after it in a passing one (they break it). */
  suspects: string[];
  /** Tests that ran before it in every passing order but after it in a failing one (it relies on them). */
  reliesOn: string[];
  headline?: string;
}

function attemptKey(a: Pick<TestAttempt, 'file' | 'title' | 'project'>): string {
  return [a.file, a.title, a.project ?? ''].join('\u0000');
}

function attemptFailed(a: TestAttempt): boolean {
  return a.status !== 'skipped' && a.status !== (a.expectedStatus ?? 'passed');
}

/**
 * Read shuffled runs (plus replays of failing seeds) per test. Pure, so the
 * verdicts are unit-tested without Playwright.
 */
export function analyzeOrder(runs: OrderRun[], replays: OrderRun[] = []): OrderFinding[] {
  const findings = new Map<string, OrderFinding>();
  const position = new Map<string, Map<string, number>>(); // seed → test → index
  for (const run of runs) {
    const order = new Map<string, number>();
    run.attempts.forEach((a, i) => {
      const key = attemptKey(a);
      if (!order.has(key)) order.set(key, i);
      if (a.status === 'skipped') return;
      let f = findings.get(key);
      if (!f) {
        f = { file: a.file, line: a.line, title: a.title, project: a.project, passedSeeds: [], failedSeeds: [], reading: 'PASSES IN EVERY ORDER', suspects: [], reliesOn: [] };
        findings.set(key, f);
      }
      if (attemptFailed(a)) {
        if (!f.failedSeeds.includes(run.seed)) f.failedSeeds.push(run.seed);
        f.headline ??= a.message;
      } else if (!f.passedSeeds.includes(run.seed)) {
        f.passedSeeds.push(run.seed);
      }
    });
    position.set(run.seed, order);
  }

  const titleOf = new Map<string, string>();
  for (const run of runs) for (const a of run.attempts) titleOf.set(attemptKey(a), a.title);

  for (const [key, f] of findings) {
    if (f.failedSeeds.length === 0) continue;
    if (f.passedSeeds.length === 0) {
      f.reading = 'FAILS IN EVERY ORDER';
      continue;
    }
    const replay = replays.find((r) => f.failedSeeds.includes(r.seed) && r.attempts.some((a) => attemptKey(a) === key));
    if (replay) {
      const failedAgain = replay.attempts.some((a) => attemptKey(a) === key && attemptFailed(a));
      f.replay = { seed: replay.seed, failedAgain };
      f.reading = failedAgain ? 'ORDER DEPENDENT' : 'FLAKY IN ANY ORDER';
    } else {
      f.reading = 'ORDER DEPENDENT';
    }
    if (f.reading !== 'ORDER DEPENDENT') continue;
    const before = (seed: string): Set<string> => {
      const order = position.get(seed);
      const mine = order?.get(key);
      if (!order || mine === undefined) return new Set();
      return new Set([...order.entries()].filter(([k, i]) => k !== key && i < mine).map(([k]) => k));
    };
    const ranBeforeIn = (seeds: string[]): Set<string> => {
      let common: Set<string> | undefined;
      for (const seed of seeds) {
        const b = before(seed);
        common = common ? new Set([...common].filter((k) => b.has(k))) : b;
      }
      return common ?? new Set();
    };
    const name = (k: string) => titleOf.get(k) ?? k;
    f.suspects = [...ranBeforeIn(f.failedSeeds)].filter((k) => f.passedSeeds.some((seed) => !before(seed).has(k))).map(name).slice(0, 3);
    f.reliesOn = [...ranBeforeIn(f.passedSeeds)].filter((k) => f.failedSeeds.some((seed) => !before(seed).has(k))).map(name).slice(0, 3);
  }
  return [...findings.values()];
}

const ORDER_TEXT: Record<OrderReading, string> = {
  'ORDER DEPENDENT':
    '🔗 **order dependent**: fails when certain tests run before it, and the failing order fails again on replay. It relies on (or is broken by) state another test leaves behind: data, storage, a logged-in session, server or module state. Give it its own setup in `beforeEach`, and clean up in the test that leaks.',
  'FLAKY IN ANY ORDER': '⏱️ **flaky regardless of order**: the failing order passed on replay, so this is timing, not test order.',
  'FAILS IN EVERY ORDER': '❌ **fails in every order**: not about order; a real bug.',
  'PASSES IN EVERY ORDER': '✅ passed in every order.',
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const VERDICT_ICON: Record<FlakyVerdict, string> = {
  'CONSISTENTLY FAILING': '❌',
  FLAKY: '⚠️',
  'NOT REPRODUCING': '✅',
  'NO TESTS RAN': '∅',
};

const VERDICT_RANK: Record<FlakyVerdict, number> = {
  'CONSISTENTLY FAILING': 3,
  FLAKY: 2,
  'NOT REPRODUCING': 1,
  'NO TESTS RAN': 0,
};

/**
 * Read the traces of a few failing runs and report a hydration race (an
 * input action while the page's scripts were still loading) or hydration
 * errors: the classic cause of a click that works on some runs only.
 */
async function hydrationClues(pass: PassResult): Promise<string[]> {
  const traces = pass.runs
    .flatMap((run) => run.result.failures ?? [])
    .map((failure) => failure.tracePath)
    .filter((path): path is string => typeof path === 'string');
  for (const path of [...new Set(traces)].slice(0, 3)) {
    const trace = await readFailureTrace(path).catch(() => null);
    if (!trace) continue;
    const notes = renderHydration(trace);
    if (notes.length > 0) return notes;
  }
  return [];
}

function verdictBlock(summary: FlakySummary): string {
  const { verdict } = summary;
  const total = summary.passed + summary.failed;
  switch (verdict) {
    case 'CONSISTENTLY FAILING':
      return `> ❌ **CONSISTENTLY FAILING** — failed all ${total} run(s)${
        summary.sameError ? ' with the same error' : `, but the errors differ (${summary.distinctSignatures} distinct signatures)`
      }. This is **not flaky**: there is a real, reproducible bug. Use \`get-failure\` for the full trace and fix it.`;
    case 'FLAKY':
      return `> ⚠️ **FLAKY** — ${summary.passed} of ${total} run(s) passed${
        summary.sameError
          ? ' and the failures share one signature (a real intermittent bug, not random noise)'
          : ` and failures vary (${summary.distinctSignatures} distinct signatures — often timing/environment instability)`
      }. Quarantine or stabilize it: re-run under load, check for missing \`await\`s, race conditions and shared state.`;
    case 'NOT REPRODUCING':
      return `> ✅ **NOT REPRODUCING** — passed all ${total} run(s). The failure you saw was one-off (transient environment, network, or a change already fixed it). Re-run the full suite with \`run-test\` to confirm.`;
    case 'NO TESTS RAN':
    default:
      return '> ⚠️ **NO TESTS RAN** — the filter matched nothing (or the run crashed before executing). Check `testFiles` with `list-tests`.';
  }
}

const READING_TEXT: Record<IsolationReading, string> = {
  'PARALLEL ONLY':
    '🔀 **fails only in parallel** — passes every run alone. Look for shared state between tests: the same user/account, DB rows, files, ports or global fixtures. Give each worker its own data (`testInfo.workerIndex`) or mark the file `test.describe.configure({ mode: \'serial\' })`.',
  'FLAKY ALONE TOO':
    '⏱️ **flaky even alone** — the race is inside the test or the app: missing `await`, asserting before the UI settles, animation or network timing. Prefer web-first assertions (`await expect(locator)…`).',
  'FAILS EITHER WAY': '❌ **fails alone too** — not a parallelism problem; fix it as a real bug.',
  'NOT REPRODUCING': '✅ passed every parallel run, so it was not re-run alone.',
};

function durationRange(outcomes: FlakyRunOutcome[]): string {
  const values = outcomes.filter((o) => !o.noTests).map((o) => o.durationMs);
  if (values.length === 0) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max || max - min < 50 ? formatDuration(max) : `${formatDuration(min)}–${formatDuration(max)}`;
}

function testLabel(evidence: TestEvidence): string {
  const project = evidence.project ? ` [${evidence.project}]` : '';
  return `\`${evidenceTarget(evidence)}\` ${markdownCell(clipLines(evidence.title, 1, 80))}${project}`;
}

function firstHeadline(outcomes: FlakyRunOutcome[]): string {
  const headline = outcomes.find((o) => o.headline)?.headline;
  return headline ? markdownCell(clipLines(headline, 1, 140)) : '—';
}

interface PassResult {
  /** Per test, in first-seen order. Empty when the attempts reporter gave nothing. */
  tests: TestEvidence[];
  /** Run-level outcomes (one per Playwright process). */
  runs: Array<FlakyRunOutcome & { result: RunTestResult }>;
  durationMs: number;
}

function renderPerTest(pass: PassResult): string[] {
  const lines = ['| test | passed | failed | time | verdict | first error |', '| --- | ---: | ---: | --- | --- | --- |'];
  for (const evidence of pass.tests) {
    const summary = summarizeFlaky(evidence.outcomes);
    lines.push(
      `| ${testLabel(evidence)} | ${summary.passed} | ${summary.failed} | ${durationRange(evidence.outcomes)} | ${VERDICT_ICON[summary.verdict]} ${summary.verdict} | ${firstHeadline(evidence.outcomes)} |`,
    );
  }
  return lines;
}

function renderRunTable(pass: PassResult): string[] {
  const lines = ['| run | status | duration | first failure |', '| ---: | --- | --- | --- |'];
  pass.runs.forEach((run, i) => {
    const status = run.noTests ? '∅ no tests' : run.ok ? '✅ passed' : run.errorKind ? `🛑 ${run.errorKind}` : '❌ failed';
    const failure = run.headline ? markdownCell(clipLines(run.headline, 1, 160)) : '—';
    lines.push(`| ${i + 1} | ${status} | ${formatDuration(run.durationMs)} | ${failure} |`);
  });
  return lines;
}

/** Summaries per test, or one summary for the whole run when per-test evidence is missing. */
function summaries(pass: PassResult): Array<{ evidence?: TestEvidence; summary: FlakySummary }> {
  if (pass.tests.length > 0) return pass.tests.map((evidence) => ({ evidence, summary: summarizeFlaky(evidence.outcomes) }));
  return [{ summary: summarizeFlaky(pass.runs) }];
}

function renderVerdicts(pass: PassResult): string[] {
  const all = summaries(pass);
  if (all.length === 1) return [verdictBlock(all[0].summary)];
  const lines: string[] = [];
  const counts = new Map<FlakyVerdict, number>();
  for (const { summary } of all) counts.set(summary.verdict, (counts.get(summary.verdict) ?? 0) + 1);
  lines.push(
    `**${all.length} tests:** ${[...counts.entries()]
      .sort((a, b) => VERDICT_RANK[b[0]] - VERDICT_RANK[a[0]])
      .map(([verdict, n]) => `${VERDICT_ICON[verdict]} ${n} ${verdict.toLowerCase()}`)
      .join(' · ')}`,
    '',
  );
  const worst = all.reduce((a, b) => (VERDICT_RANK[b.summary.verdict] > VERDICT_RANK[a.summary.verdict] ? b : a));
  lines.push(`Worst: ${worst.evidence ? testLabel(worst.evidence) : 'the run'}`, '', verdictBlock(worst.summary));
  return lines;
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

function ranNoTests(result: RunTestResult): boolean {
  const s = result.stats;
  return s !== null && s.expected === 0 && s.unexpected === 0 && s.flaky === 0 && s.skipped === 0;
}

function runOutcome(result: RunTestResult): FlakyRunOutcome {
  const first = result.failures[0];
  const noTests = ranNoTests(result);
  return {
    ok: result.ok && !noTests,
    durationMs: result.durationMs,
    signature: failureSignature(first),
    headline: first ? first.message.split('\n')[0] : undefined,
    noTests,
    errorKind: !result.ok && result.failures.length === 0 ? result.errorKind : undefined,
  };
}

/** A run-level hard error (spawn/timeout/config) that will repeat on every run. */
function isHardError(result: RunTestResult): boolean {
  return !result.ok && result.failures.length === 0 && result.errorKind !== undefined && result.errorKind !== 'REPORT_MISSING';
}

interface PassOptions {
  root: string;
  configPath?: string;
  targets: string[];
  runs: number;
  separateProcesses: boolean;
  workers?: number;
  fullyParallel?: boolean;
  args: DiagnoseFlakyInput;
  ctx: ToolContext;
  label: string;
  /** A pytest-playwright project: one pytest process per run, workers via pytest-xdist. */
  pytest?: boolean;
  /** Progress slots already used and the total, so two passes share one bar. */
  progressOffset: number;
  progressTotal: number;
}

async function runPass(options: PassOptions): Promise<PassResult> {
  const { root, args, ctx } = options;
  const perRunTimeout = args.timeoutMs ?? 120_000;
  const processes = options.separateProcesses ? options.runs : 1;
  const runs: PassResult['runs'] = [];
  const attempts: TestAttempt[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < processes; i += 1) {
    if (ctx.signal?.aborted) break;
    ctx.logger.info('diagnose-flaky run', { pass: options.label, run: i + 1, of: processes, targets: options.targets });
    const result = await runTests({
      projectRoot: root,
      configPath: options.configPath,
      testFiles: options.targets,
      browser: args.browser,
      headed: args.headed,
      ...(options.pytest
        ? { extraArgs: options.workers !== undefined && options.workers > 1 ? [`-n=${options.workers}`] : [] }
        : { workers: options.workers, fullyParallel: options.fullyParallel }),
      repeatEach: options.separateProcesses ? undefined : options.runs,
      timeoutMs: options.separateProcesses ? perRunTimeout : Math.min(perRunTimeout * options.runs, 3_600_000),
      retries: 0,
      retryOnFailure: false,
      collectAttempts: true,
      signal: ctx.signal,
    });
    const repetitions = !options.separateProcesses && result.attempts?.length ? splitRepetitions(result, result.attempts) : [result];
    for (const repetition of repetitions) await recordRun(root, repetition, 'diagnose-flaky').catch(() => undefined);
    attempts.push(...(options.pytest ? attemptsFromOutcomes(result, i) : (result.attempts ?? [])));
    runs.push({ ...runOutcome(result), result });
    const done = options.separateProcesses ? i + 1 : options.runs;
    ctx.progress?.(
      options.progressOffset + done,
      options.progressTotal,
      `${options.label}: ${done} of ${options.runs} repetition(s) done, ${result.ok ? 'all passed' : 'failures seen'}`,
    );
    if (isHardError(result)) break;
  }

  return { tests: groupAttempts(attempts), runs, durationMs: Date.now() - startedAt };
}

/**
 * pytest has no per-attempt reporter: each run is its own process, so every
 * test's final outcome in run `index` is that repetition's attempt.
 */
export function attemptsFromOutcomes(result: RunTestResult, index: number): TestAttempt[] {
  return (result.outcomes ?? []).map((o) => ({
    file: o.file,
    ...(o.line !== undefined ? { line: o.line } : {}),
    title: o.title,
    ...(o.project ? { project: o.project } : {}),
    repeatEachIndex: index,
    retry: 0,
    status: o.status,
    durationMs: o.durationMs ?? 0,
    ...(o.message ? { message: o.message } : {}),
  }));
}

/**
 * Split one --repeat-each run into one run per repetition, so run history
 * (analyze-history) counts every repetition as its own run, exactly as it
 * did when each repetition was a separate process.
 */
export function splitRepetitions(result: RunTestResult, attempts: TestAttempt[]): RunTestResult[] {
  const byRepeat = new Map<number, TestOutcome[]>();
  for (const attempt of attempts) {
    const outcomes = byRepeat.get(attempt.repeatEachIndex) ?? [];
    const failed = attempt.status !== (attempt.expectedStatus ?? 'passed') && attempt.status !== 'skipped';
    outcomes.push({
      file: attempt.file,
      line: attempt.line,
      title: attempt.title,
      project: attempt.project,
      status: attempt.status,
      durationMs: attempt.durationMs,
      ...(failed
        ? { message: attempt.message?.slice(0, 200), failureKind: classifyFailure(attempt.message ?? '', attempt.status) }
        : {}),
    });
    byRepeat.set(attempt.repeatEachIndex, outcomes);
  }
  return [...byRepeat.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, outcomes]) => {
      const passed = outcomes.filter((o) => !o.message && o.status !== 'skipped').length;
      const skipped = outcomes.filter((o) => o.status === 'skipped').length;
      const failed = outcomes.length - passed - skipped;
      const durationMs = outcomes.reduce((sum, o) => sum + (o.durationMs ?? 0), 0);
      return {
        ...result,
        ok: failed === 0,
        outcomes,
        durationMs,
        stats: { expected: passed, unexpected: failed, flaky: 0, skipped, duration: durationMs },
      };
    });
}

/** True when `import <name>` works in the project's Python. */
async function hasPythonModule(root: string, name: string): Promise<boolean> {
  const python = await resolvePython(root).catch(() => undefined);
  if (!python) return false;
  const outcome = await runProcess(python, ['-c', `import ${name}`], { cwd: root, env: childEnv(), timeoutMs: 20_000 }).catch(() => undefined);
  return outcome?.code === 0;
}

function failingTargets(pass: PassResult): string[] {
  return [
    ...new Set(
      pass.tests
        .filter((evidence) => evidence.outcomes.some((o) => !o.ok && !o.noTests))
        .map((evidence) => evidenceTarget(evidence)),
    ),
  ];
}

function modeLine(pass: PassResult, options: { runs: number; separateProcesses: boolean; workers?: number; fullyParallel?: boolean; pytest?: boolean }): string {
  if (options.pytest) {
    const xdist = options.workers !== undefined && options.workers > 1 ? `, \`-n ${options.workers}\` (pytest-xdist)` : '';
    return `**Mode:** ${options.runs} separate pytest runs${xdist}; reruns disabled so each run is honest evidence. Took ${formatDuration(pass.durationMs)}.`;
  }
  const how = options.separateProcesses
    ? `${options.runs} separate Playwright processes`
    : `one Playwright process with \`--repeat-each=${options.runs}\``;
  const workers = options.workers !== undefined ? `, \`--workers=${options.workers}\`` : '';
  const parallel = options.fullyParallel ? ', `--fully-parallel`' : '';
  return `**Mode:** ${how}${workers}${parallel}; Playwright retries disabled (\`--retries=0\`, no auto-retry) so each run is honest evidence. Took ${formatDuration(pass.durationMs)}.`;
}

/**
 * Run the target files in `runs` random orders with one worker, replay a
 * failing order to rule out timing, and render what that shows.
 */
async function orderPass(options: {
  root: string;
  configPath?: string;
  targets: string[];
  runs: number;
  args: DiagnoseFlakyInput;
  ctx: ToolContext;
  version: string | null | undefined;
}): Promise<string[]> {
  const { root, args, ctx } = options;
  const lines = ['### Test order (`--shuffle`, one worker)', ''];
  if (!supportsShuffle(options.version)) {
    lines.push(`Skipped: random test order needs Playwright 1.64 or newer (this project has ${options.version ?? 'an unknown version'}).`, '');
    return lines;
  }
  const files = [...new Set(options.targets.map((t) => t.replace(/:\d+(?::\d+)?$/, '')))];
  const shown = files.map((f) => relativeToRoot(root, f));
  const run = async (seed: string): Promise<OrderRun | undefined> => {
    const result = await runTests({
      projectRoot: root,
      configPath: options.configPath,
      testFiles: files,
      browser: args.browser,
      workers: 1,
      fullyParallel: true,
      shuffleSeed: seed,
      timeoutMs: args.timeoutMs ?? 120_000,
      retries: 0,
      retryOnFailure: false,
      collectAttempts: true,
      signal: ctx.signal,
    });
    await recordRun(root, result, 'diagnose-flaky').catch(() => undefined);
    if (isHardError(result) || !result.attempts?.length) return undefined;
    return { seed, attempts: result.attempts };
  };

  // PW_MCP_SHUFFLE_SEEDS (comma separated) replays earlier orders, e.g. to
  // re-check a fix against the exact seeds a diagnosis reported.
  const fixedSeeds = (process.env.PW_MCP_SHUFFLE_SEEDS ?? '').split(',').map((v) => v.trim()).filter((v) => /^\d{1,15}$/.test(v));
  const runs: OrderRun[] = [];
  for (let i = 0; i < options.runs && !ctx.signal?.aborted; i += 1) {
    const seed = fixedSeeds[i] ?? String(Math.floor(Math.random() * 1e9));
    ctx.progress?.(i, options.runs, `test order: ${i} of ${options.runs} random order(s) done`);
    const outcome = await run(seed);
    if (!outcome) break;
    runs.push(outcome);
  }
  if (runs.length === 0) {
    lines.push('The shuffled runs did not report any tests (a run-level error); see the runs above.', '');
    return lines;
  }
  let findings = analyzeOrder(runs);
  const replaySeeds = [...new Set(findings.filter((f) => f.reading === 'ORDER DEPENDENT').map((f) => f.failedSeeds[0]))].slice(0, 2);
  const replays: OrderRun[] = [];
  for (const seed of replaySeeds) {
    if (ctx.signal?.aborted) break;
    const outcome = await run(seed);
    if (outcome) replays.push(outcome);
  }
  if (replays.length > 0) findings = analyzeOrder(runs, replays);

  const seeds = runs.map((r) => `\`${r.seed}\``).join(', ');
  const failing = findings.filter((f) => f.failedSeeds.length > 0);
  if (failing.length === 0) {
    lines.push(`All ${findings.length} test(s) in ${shown.map((f) => `\`${f}\``).join(', ')} passed in ${runs.length} random orders (seeds ${seeds}): no order dependence.`, '');
    return lines;
  }
  lines.push(`${runs.length} random orders of ${shown.map((f) => `\`${f}\``).join(', ')} (seeds ${seeds})${replays.length ? `, failing order replayed ${replays.length}×` : ''}:`, '');
  lines.push('| test | orders passed | failing seed(s) | reading |', '| --- | --- | --- | --- |');
  for (const f of failing) {
    const total = f.passedSeeds.length + f.failedSeeds.length;
    lines.push(
      `| ${testLabel({ file: f.file, line: f.line, title: f.title, project: f.project, outcomes: [] })} | ${f.passedSeeds.length}/${total} | ${f.failedSeeds.map((s) => `\`${s}\``).join(', ')} | ${ORDER_TEXT[f.reading]} |`,
    );
  }
  lines.push('');
  for (const f of failing.filter((x) => x.reading === 'ORDER DEPENDENT')) {
    const seed = f.replay?.seed ?? f.failedSeeds[0];
    lines.push(`**${clipLines(f.title, 1, 80)}**`);
    const names = (list: string[]) => list.map((t) => `\`${clipLines(t, 1, 80)}\``).join(', ');
    if (f.suspects.length) lines.push(`- Broken by: ${names(f.suspects)} (ran before it in every failing order, after it in a passing one)`);
    if (f.reliesOn.length) lines.push(`- Relies on: ${names(f.reliesOn)} (ran before it in every passing order, after it in a failing one)`);
    if (f.headline) lines.push(`- Error: ${markdownCell(clipLines(f.headline, 1, 160))}`);
    lines.push(`- Reproduce: \`npx playwright test ${shown.join(' ')} --workers=1 --fully-parallel --retries=0 --shuffle=${seed}\``, '');
  }
  return lines;
}

export const diagnoseFlakyTool = {
  name: 'diagnose-flaky',
  description:
    'Repeat failing tests (Playwright or pytest-playwright) with retries disabled and return a per-test, evidence-based verdict: CONSISTENTLY FAILING (real bug), FLAKY (pass/fail counts, error-signature variance, duration spread) or NOT REPRODUCING. Runs all repetitions in one process by default. `isolate: true` also re-runs the failures with one worker to tell parallelism bugs (shared state) from flakiness inside the test; `order: true` (Playwright 1.64+) runs the files in random orders to catch tests that depend on what ran before them. Defaults to the tests that failed in the most recent run.',
  inputSchema: diagnoseFlakySchema,
  handler: async (args: DiagnoseFlakyInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('diagnose-flaky', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const detection = await detectProject(root);

      const pytest = !detection.hasPlaywright && (await detectPytestProject(root)) !== null;
      if (pytest && args.order === true) {
        return toolError(
          'INVALID_INPUT',
          'order is not available for pytest projects',
          'pytest has no built-in shuffle. Install pytest-randomly and re-run with run-test a few times to look for order dependence; diagnose-flaky without order and isolate: true still separate flakiness from parallelism.',
        );
      }
      if (pytest && args.isolate === true && !(await hasPythonModule(root, 'xdist'))) {
        return toolError(
          'INVALID_INPUT',
          'isolate needs pytest-xdist in a pytest project',
          'Install it (`pip install pytest-xdist`) so the tests can run in parallel first, or call diagnose-flaky without isolate.',
        );
      }
      if (!detection.hasPlaywright && !pytest) {
        const { message, hint } = missingPlaywrightMessage(detection);
        return toolText([`## Flaky diagnosis unavailable`, '', `**Error:** ${message}`, '', `> ${hint}`].join('\n'), {
          ok: false,
          error: { kind: 'NO_PLAYWRIGHT', message, hint },
        });
      }

      const configPath = pytest ? undefined : resolveConfigSelection(detection, args.config);

      // Target set: explicit, or the failures of the most recent run.
      let target = args.testFiles ?? [];
      if (target.length === 0) {
        const last = ctx.store.lastRun;
        const failedFiles = [
          ...new Set(
            (last?.result.failures ?? [])
              .map((f: TestFailure) => f.file)
              .filter((f): f is string => typeof f === 'string' && f !== ''),
          ),
        ];
        if (failedFiles.length === 0) {
          throw new PlaywrightMcpError('No tests to diagnose', 'INVALID_PATH', {
            hint: 'Pass `testFiles`, or call `run-test` first so the previously failed tests can be reused as the target set.',
          });
        }
        target = failedFiles;
      }

      const sanitized: string[] = [];
      const missing: string[] = [];
      for (const raw of target) {
        const absolute = sanitizeTestPathArgument(raw, root);
        sanitized.push(absolute);
        if (!(await testPathExists(absolute, root))) missing.push(raw);
      }
      if (missing.length > 0) {
        throw new PlaywrightMcpError(`Test path(s) not found: ${missing.join(', ')}`, 'INVALID_PATH', {
          hint: `Paths resolve inside ${root}. Call list-tests to see the available tests.`,
        });
      }

      const runsRequested = args.runs ?? 3;
      // pytest cannot repeat inside one process (no --repeat-each), so each run is its own.
      const separateProcesses = pytest || args.separateProcesses === true;
      const isolate = args.isolate === true;
      const parallelWorkers = isolate ? (args.workers ?? 4) : args.workers;
      const progressTotal = isolate ? runsRequested * 2 : runsRequested;

      const main = await runPass({
        root,
        configPath,
        targets: sanitized,
        runs: runsRequested,
        separateProcesses,
        workers: parallelWorkers,
        fullyParallel: isolate,
        args,
        ctx,
        label: isolate ? 'parallel' : 'diagnosis',
        pytest,
        progressOffset: 0,
        progressTotal,
      });

      let alone: PassResult | undefined;
      const toIsolate = isolate ? failingTargets(main) : [];
      if (toIsolate.length > 0 && !ctx.signal?.aborted) {
        alone = await runPass({
          root,
          configPath,
          targets: toIsolate.map((t) => sanitizeTestPathArgument(t, root)),
          runs: runsRequested,
          separateProcesses,
          workers: 1,
          args,
          ctx,
          label: 'isolated',
          pytest,
          progressOffset: runsRequested,
          progressTotal,
        });
      }

      const lastRun = (alone ?? main).runs.at(-1)?.result ?? main.runs.at(-1)?.result;
      const mainLast = main.runs.at(-1)?.result;
      // get-failure should see the failing (parallel) evidence, not a clean isolated pass.
      const forStore = mainLast && !mainLast.ok ? mainLast : lastRun;
      if (forStore) ctx.store.setLastRun({ projectRoot: root, result: forStore, at: Date.now() });

      const mainSummaries = summaries(main);
      ctx.logger.info('diagnose-flaky finished', {
        tests: main.tests.length,
        verdicts: mainSummaries.map((s) => s.summary.verdict),
        isolated: alone?.tests.length ?? 0,
        durationMs: main.durationMs + (alone?.durationMs ?? 0),
      });

      if (main.runs.length > 0 && main.runs.every((r) => r.errorKind) && main.tests.length === 0) {
        const kinds = [...new Set(main.runs.map((r) => r.errorKind))].join(', ');
        const last = main.runs.at(-1)?.result;
        return toolText(
          [
            '## Flaky diagnosis could not run',
            '',
            `Every attempt failed at the run level (\`${kinds}\`) before any test executed.`,
            '',
            last?.errorMessage ? clipLines(last.errorMessage, 4, 600) : '',
            last?.hint ? `> ${last.hint}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          { ok: false, verdict: 'NO TESTS RAN', error: { kind: kinds, message: last?.errorMessage ?? 'every attempt failed before any test ran' } },
        );
      }

      const shown = sanitized.map((file) => relativeToRoot(root, file));
      const lines: string[] = [
        `## Flaky diagnosis — ${shown.map((t) => `\`${t}\``).join(', ')} × ${runsRequested} runs`,
        '',
        modeLine(main, { runs: runsRequested, separateProcesses, workers: parallelWorkers, fullyParallel: isolate, pytest }),
        '',
      ];
      if (main.tests.length > 0) lines.push(...renderPerTest(main));
      if (main.tests.length === 0 || separateProcesses) {
        if (main.tests.length > 0) lines.push('');
        lines.push(...renderRunTable(main));
      }
      lines.push('', ...renderVerdicts(main), '');
      lines.push(...(await hydrationClues(main)));

      if (isolate) {
        lines.push(
          pytest
            ? `### Parallel vs alone (\`-n ${parallelWorkers}\` → one process)`
            : `### Parallel vs alone (\`--workers=${parallelWorkers}\` fully parallel → \`--workers=1\`)`,
          '',
        );
        if (!alone) {
          lines.push(
            main.tests.length === 0
              ? 'Per-test evidence was not available, so nothing was re-run alone.'
              : 'Every test passed every parallel run, so nothing needed a run alone.',
            '',
          );
        } else {
          const aloneByTarget = new Map(alone.tests.map((e) => [`${evidenceTarget(e)}\u0000${e.title}\u0000${e.project ?? ''}`, e]));
          lines.push('| test | parallel | alone | reading |', '| --- | --- | --- | --- |');
          for (const evidence of main.tests) {
            const parallel = summarizeFlaky(evidence.outcomes);
            if (parallel.failed === 0) continue;
            const isolatedEvidence = aloneByTarget.get(`${evidenceTarget(evidence)}\u0000${evidence.title}\u0000${evidence.project ?? ''}`);
            const isolated = isolatedEvidence ? summarizeFlaky(isolatedEvidence.outcomes) : undefined;
            const reading = isolationReading(parallel, isolated);
            const aloneCell = isolated ? `${isolated.passed}/${isolated.passed + isolated.failed} passed` : 'not run';
            lines.push(
              `| ${testLabel(evidence)} | ${parallel.passed}/${parallel.passed + parallel.failed} passed | ${aloneCell} | ${READING_TEXT[reading]} |`,
            );
          }
          lines.push('', `Isolated pass took ${formatDuration(alone.durationMs)}.`, '');
        }
      }

      if (args.order === true && !ctx.signal?.aborted) {
        lines.push(...(await orderPass({ root, configPath, targets: sanitized, runs: runsRequested, args, ctx, version: detection.playwrightVersion })));
      }

      const worst = mainSummaries.reduce((a, b) => (VERDICT_RANK[b.summary.verdict] > VERDICT_RANK[a.summary.verdict] ? b : a));
      if (worst.summary.verdict === 'FLAKY' || worst.summary.verdict === 'CONSISTENTLY FAILING') {
        lines.push('**Next steps:**', '');
        lines.push('1. `get-failure` for the full error, DOM snapshot and failed requests of the last failing run.');
        lines.push('2. `suggest-fix` when the error is a locator or expectation drift; re-run with `run-test` and `lastFailed: true` after any fix.');
        if (worst.summary.verdict === 'FLAKY' && !isolate) {
          lines.push('3. `isolate: true` tells a shared-state/parallelism bug from a race inside the test; `runs: 5` gives stronger evidence before quarantining.');
        }
        lines.push('');
      }

      return toolText(lines.join('\n'), {
        ok: worst.summary.verdict === 'NOT REPRODUCING',
        verdict: worst.summary.verdict,
        tests: mainSummaries
          .filter((entry) => entry.evidence)
          .map(({ evidence, summary }) => ({
            file: evidence!.file,
            ...(evidence!.line !== undefined ? { line: evidence!.line } : {}),
            title: evidence!.title,
            ...(evidence!.project ? { project: evidence!.project } : {}),
            verdict: summary.verdict,
            passed: summary.passed,
            failed: summary.failed,
          })),
      });
    }),
};
