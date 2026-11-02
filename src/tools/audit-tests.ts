/**
 * Tool — audit-tests: find the code in a Playwright suite that makes tests
 * flaky (hard waits, one-shot assertions, promises nobody awaits, `.only`,
 * layout selectors…) and rank it by how unstable those tests have actually
 * been in the local run history. With `fix: true` it rewrites the
 * mechanical cases (web-first assertions, missing awaits, `.only`), re-runs
 * the files it touched, and restores them if the run fails.
 */

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { RunTestResult, ToolContext, ToolResponse } from '../types/index.js';
import { applyFlakeFixes, scanFlakeRisks, SEVERITY_WEIGHT, ssrFramework } from '../utils/flake-rules.js';
import type { FlakeFinding, FlakeSeverity } from '../utils/flake-rules.js';
import { joinProjectPath, isPathInside, sanitizeUserPath, toNativePath, writeFileInsideRoot } from '../utils/path-utils.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectProject, findTestFiles } from '../utils/project-detector.js';
import { scanPythonFlakeRisks } from '../utils/flake-rules-python.js';
import { detectPytestProject } from '../utils/pytest-runner.js';
import { readHistory, recordRun, testStats } from '../utils/run-history.js';
import type { TestStats } from '../utils/run-history.js';
import {
  clipLines,
  codeFence,
  formatDuration,
  guard,
  markdownCell,
  resolveConfigSelection,
  resolveProjectRoot,
  toolText,
  confirmBeforeWrite,
  declinedResult,
} from './shared.js';

const MAX_FILE_BYTES = 1_000_000;

const auditTestsInput = z.object({
  projectRoot: z.string().optional().describe('Project directory; defaults to the server working directory'),
  testDir: z.string().optional().describe('Audit only this directory (inside the project); defaults to the config testDir'),
  filter: z.string().optional().describe('Case-insensitive substring filter on the file path'),
  minSeverity: z.enum(['low', 'medium', 'high']).optional().describe('Report findings at or above this severity (default low)'),
  historyRuns: z.number().int().min(1).max(1_000).optional().describe('How many recent runs of the local history to weigh in (default 50)'),
  limit: z.number().int().min(1).max(500).optional().describe('Max findings to list (default 50); the summary counts all'),
  fix: z
    .boolean()
    .optional()
    .describe('Rewrite the mechanical findings (web-first assertions, missing awaits, .only), re-run the touched files and restore them if the run fails'),
  verify: z.boolean().optional().describe('With fix: re-run the touched files (default true)'),
  config: z.string().optional().describe('playwright.config path or 1-based index, for the verify run'),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).optional().describe('Wall-clock limit for the verify run'),
});

export type AuditTestsInput = z.infer<typeof auditTestsInput>;

const RANK: Readonly<Record<FlakeSeverity, number>> = { low: 0, medium: 1, high: 2 };

export interface FileRisk {
  file: string;
  findings: FlakeFinding[];
  /** Tests of this file in the history that flipped or were flaky. */
  unstable: TestStats[];
  /** Worst (failed + flaky) / runs among the file's tests in the history. */
  failRate: number;
  score: number;
}

function sameFile(historyFile: string, file: string): boolean {
  return historyFile === file || file.endsWith(`/${historyFile}`) || historyFile.endsWith(`/${file}`);
}

/** Group findings by file and weigh each file by its history: code smells in tests that already flake come first. */
export function rankFileRisks(findings: FlakeFinding[], stats: TestStats[]): FileRisk[] {
  const byFile = new Map<string, FlakeFinding[]>();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  const out: FileRisk[] = [];
  for (const [file, list] of byFile) {
    const mine = stats.filter((s) => sameFile(s.file, file));
    const unstable = mine.filter((s) => s.flaky > 0 || s.flips >= 2).sort((a, b) => b.flipRate - a.flipRate);
    const failRate = mine.reduce((worst, s) => Math.max(worst, s.failRate), 0);
    const base = list.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
    out.push({ file, findings: list, unstable, failRate, score: Math.round(base * (1 + 3 * failRate) * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

/** True when the finding's test flaked or flipped in the history. */
function flakedBefore(finding: FlakeFinding, risk: FileRisk): boolean {
  return finding.test !== undefined && risk.unstable.some((s) => s.title === finding.test || s.title.endsWith(` › ${finding.test}`));
}

const ICON: Readonly<Record<FlakeSeverity, string>> = { high: '🔴', medium: '🟠', low: '🟡' };

function counts(findings: FlakeFinding[]): string {
  const n = (sev: FlakeSeverity): number => findings.filter((f) => f.severity === sev).length;
  return `${n('high')} / ${n('medium')} / ${n('low')}`;
}

function renderAudit(risks: FileRisk[], scanned: number, historyRuns: number, limit: number): { markdown: string; shown: FlakeFinding[] } {
  const all = risks.flatMap((r) => r.findings);
  const lines: string[] = [];
  if (all.length === 0) {
    lines.push(`## ✅ No flake risks found in ${scanned} spec file${scanned === 1 ? '' : 's'}`);
    return { markdown: lines.join('\n'), shown: [] };
  }
  const fixable = all.filter((f) => f.fix !== undefined).length;
  lines.push(
    `## 🧪 ${all.length} flake risk${all.length === 1 ? '' : 's'} in ${risks.length} of ${scanned} spec file${scanned === 1 ? '' : 's'}`,
    '',
    historyRuns > 0
      ? `Ranked by severity and by how the tests behaved in the last ${historyRuns} recorded run${historyRuns === 1 ? '' : 's'}.`
      : 'No run history yet, so ranked by severity alone. Runs through run-test (or load-report in CI) build it up.',
    fixable > 0 ? `**${fixable}** can be fixed mechanically: call again with \`fix: true\` to apply them and re-run the files.` : '',
    '',
    '| File | 🔴 / 🟠 / 🟡 | History | Risk |',
    '|---|---|---|---|',
  );
  for (const risk of risks.slice(0, 20)) {
    const history =
      risk.unstable.length > 0
        ? `${risk.unstable.length} flaky test${risk.unstable.length === 1 ? '' : 's'}, worst ${Math.round(risk.failRate * 100)}% failing`
        : risk.failRate > 0
          ? `${Math.round(risk.failRate * 100)}% failing`
          : '—';
    lines.push(`| \`${markdownCell(risk.file)}\` | ${counts(risk.findings)} | ${history} | ${risk.score} |`);
  }
  if (risks.length > 20) lines.push(`| _…${risks.length - 20} more files_ | | | |`);
  lines.push('');

  // Findings: the riskiest files first, severity first inside a file.
  const ordered = risks.flatMap((risk) =>
    [...risk.findings].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.line - b.line).map((f) => ({ f, risk })),
  );
  const shown = ordered.slice(0, limit);
  lines.push('### Findings', '');
  for (const { f, risk } of shown) {
    const flaked = flakedBefore(f, risk) ? ' · 🔥 flaky in history' : '';
    lines.push(`- ${ICON[f.severity]} **${f.rule}** \`${f.file}:${f.line}\`${f.test ? ` in “${f.test}”` : ''}${flaked}`);
    lines.push(`  \`${clipLines(f.code, 1, 160)}\``);
    lines.push(`  ${f.message}`);
    if (f.fix !== undefined) lines.push(`  Fix: \`${clipLines(f.fix.trim(), 1, 160)}\``);
  }
  if (ordered.length > shown.length) lines.push('', `_Showing ${shown.length} of ${ordered.length}. Raise \`limit\`, set \`minSeverity\` or \`filter\`._`);
  return { markdown: lines.join('\n'), shown: shown.map(({ f }) => f) };
}

function findingData(f: FlakeFinding) {
  return {
    file: f.file,
    line: f.line,
    rule: f.rule,
    severity: f.severity,
    message: f.message,
    ...(f.fix !== undefined ? { fix: f.fix } : {}),
    ...(f.test ? { test: f.test } : {}),
  };
}

export const auditTestsTool = {
  name: 'audit-tests',
  description:
    'Audit the Playwright test code for flake risks (hard waits, one-shot assertions instead of web-first ones, missing awaits, .only, force clicks, networkidle, element handles, layout selectors, acting right after goto on a server-rendered app before it hydrates) and rank files by how flaky their tests have been in the run history. fix: true rewrites the mechanical ones, re-runs the touched files and restores them if the run fails. TS/JS specs and pytest-playwright modules.',
  inputSchema: auditTestsInput,
  handler: async (args: AuditTestsInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('audit-tests', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      if (args.fix && ctx.restricted) {
        throw new PlaywrightMcpError('fix is not available on this server', 'INVALID_PATH', {
          hint: 'Run the audit without fix, or use a local install to apply fixes.',
        });
      }
      const detection = await detectProject(root);
      // pytest-playwright suites: scan test_*.py / *_test.py with the Python rules.
      const python = !detection.hasPlaywright && (await detectPytestProject(root)) !== null;
      let testDir: string | null = detection.testDir;
      if (args.testDir !== undefined) testDir = sanitizeUserPath(args.testDir, root);
      else if (testDir !== null && !isPathInside(testDir, root)) testDir = null;

      const wanted = args.filter?.toLowerCase();
      const ssr = ssrFramework(await readFile(toNativePath(joinProjectPath(root, 'package.json')), 'utf8').then((text) => JSON.parse(text) as Parameters<typeof ssrFramework>[0], () => undefined));
      const files = (await findTestFiles(root, { testDir, limit: 2_000, python })).filter((f) => !wanted || f.toLowerCase().includes(wanted));
      const minRank = RANK[args.minSeverity ?? 'low'];
      const sources = new Map<string, string>();
      const findings: FlakeFinding[] = [];
      for (const file of files) {
        const full = joinProjectPath(root, file);
        const info = await stat(toNativePath(full)).catch(() => null);
        if (!info || info.size > MAX_FILE_BYTES) continue;
        const source = await readFile(toNativePath(full), 'utf8');
        sources.set(file, source);
        findings.push(...(python ? scanPythonFlakeRisks(file, source) : scanFlakeRisks(file, source, { ssr })).filter((f) => RANK[f.severity] >= minRank));
      }

      const history = await readHistory(root, args.historyRuns ?? 50).catch(() => []);
      const risks = rankFileRisks(findings, testStats(history));
      const { markdown, shown } = renderAudit(risks, files.length, history.length, args.limit ?? 50);
      ctx.logger.info('audit-tests finished', { files: files.length, findings: findings.length, historyRuns: history.length });
      const data = { findings: shown.map(findingData), total: findings.length, truncated: shown.length < findings.length };

      if (!args.fix) return toolText(markdown, data);

      // Fix: rewrite each file's mechanical findings in one pass.
      const out = [markdown, '', '## 🔧 Fixes'];
      const touched = new Map<string, string>();
      const applied: FlakeFinding[] = [];
      const planned: Array<{ file: string; full: string; original: string; source: string; applied: FlakeFinding[] }> = [];
      for (const risk of risks) {
        const original = sources.get(risk.file);
        if (original === undefined) continue;
        const result = applyFlakeFixes(original, risk.findings);
        if (result.applied.length === 0) continue;
        planned.push({ file: risk.file, full: joinProjectPath(root, risk.file), original, source: result.source, applied: result.applied });
      }
      let confirmed: Awaited<ReturnType<typeof confirmBeforeWrite>> = 'not-asked';
      if (planned.length > 0) {
        const count = planned.reduce((sum, plan) => sum + plan.applied.length, 0);
        const detail = planned
          .flatMap((plan) => {
            const before = plan.original.split(/\r?\n/);
            return plan.applied.map((finding) => `${plan.file}:${finding.line}\n- ${(before[finding.line - 1] ?? '').trim()}\n+ ${(finding.fix ?? '').trim()}`);
          })
          .join('\n\n');
        confirmed = await confirmBeforeWrite(ctx, `Apply ${count} flake fix${count === 1 ? '' : 'es'} in ${planned.length} file${planned.length === 1 ? '' : 's'}?`, detail);
        if (confirmed === 'declined') return declinedResult('the flake fixes', { ...data, applied: false });
      }
      for (const plan of planned) {
        if ((await readFile(toNativePath(plan.full), 'utf8')) !== plan.original) continue;
        await writeFileInsideRoot(plan.full, plan.source, root);
        touched.set(plan.file, plan.original);
        applied.push(...plan.applied);
      }
      if (applied.length === 0) {
        out.push('', 'Nothing to fix mechanically: the findings above need a judgement call (what to wait for instead).');
        return toolText(out.join('\n'), { ...data, applied: false });
      }
      out.push('', `Applied ${applied.length} fix${applied.length === 1 ? '' : 'es'} in ${touched.size} file${touched.size === 1 ? '' : 's'}: ${[...touched.keys()].map((f) => `\`${f}\``).join(', ')}.`);
      if (confirmed === 'approved') out.push('', '> ✅ You confirmed these changes.');

      const restore = async (): Promise<void> => {
        for (const [file, original] of touched) await writeFileInsideRoot(joinProjectPath(root, file), original, root);
      };
      if (args.verify === false) {
        out.push('', '> Not verified (verify: false). Re-run the files with **run-test** to check them.');
        return toolText(out.join('\n'), { ...data, applied: true });
      }

      let result: RunTestResult;
      try {
        result = await runTests({
          projectRoot: root,
          configPath: resolveConfigSelection(detection, args.config),
          testFiles: [...touched.keys()],
          retries: 0,
          retryOnFailure: false,
          timeoutMs: args.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        await restore();
        throw err;
      }
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
      await recordRun(root, result, 'audit-tests').catch(() => undefined);
      if (result.ok) {
        out.push('', `### ✅ Verified: the touched files pass with the fixes (${formatDuration(result.durationMs)}).`);
      } else {
        await restore();
        const first = result.failures[0];
        out.push(
          '',
          '### ❌ The touched files failed, so every fix was reverted',
          '',
          first ? `\`${first.file}${first.line ? `:${first.line}` : ''}\` ${first.title}` : '',
          first ? codeFence(clipLines(first.message, 8, 1_200), 'text') : (result.errorMessage ?? 'The run failed without a test failure.'),
          '',
          '> If these tests failed before the fixes too, fix that first (run-test, get-failure), then audit again.',
        );
      }
      return toolText(out.join('\n'), { ...data, ok: result.ok, applied: result.ok, verified: result.ok });
    }),
};
