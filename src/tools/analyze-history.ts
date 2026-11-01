/**
 * Tool 10 — analyze-history: read the local run history and answer the
 * questions one red build cannot: which tests are flaky across runs, which
 * are simply broken, which failures share one cause, and how one test has
 * behaved over time; also which tests are slow or slowing down, how
 * stability trends day by day, and the commit where each failing or
 * flaky test went bad.
 */

import { z } from 'zod';
import type { ToolContext, ToolResponse } from '../types/index.js';
import {
  breakingCommits,
  dailyTrend,
  failurePatterns,
  historyEnabled,
  HISTORY_DIR,
  rankFlaky,
  readHistory,
  slowTests,
  testStats,
} from '../utils/run-history.js';
import type { HistoryEntry, TestStats } from '../utils/run-history.js';
import { PlaywrightMcpError } from '../types/index.js';
import { fetchRuns, mergeRuns, historyProjectName, historySettings } from '../utils/history-client.js';
import {
  clipLines,
  formatDuration,
  guard,
  markdownCell,
  resolveProjectRoot,
  toolText,
} from './shared.js';

const analyzeHistoryInput = z.object({
  view: z
    .enum(['flaky', 'patterns', 'test', 'slow', 'trend', 'commits'])
    .optional()
    .describe("Default 'flaky'; 'slow' ranks durations, 'trend' is per day, 'commits' names the commit each test went bad"),
  test: z.string().optional().describe('Filter: substring of file or title'),
  lastRuns: z.number().int().min(2).max(500).optional().describe('Runs to analyze (default 30)'),
  limit: z.number().int().min(1).max(100).optional(),
  source: z
    .enum(['local', 'cloud', 'both'])
    .optional()
    .describe("With a shared history server (PW_MCP_HISTORY_URL): 'both' (default) merges this machine's runs with CI runs from it; 'cloud' or 'local' for one side"),
  projectRoot: z.string().optional(),
});

export type AnalyzeHistoryInput = z.infer<typeof analyzeHistoryInput>;
export const analyzeHistorySchema = analyzeHistoryInput;

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function strip(stats: TestStats, width = 20): string {
  const s = stats.strip.length > width ? `…${stats.strip.slice(-width)}` : stats.strip;
  return `\`${s}\``;
}

function shortSha(commit: string | undefined): string {
  return commit ? `\`${commit.slice(0, 8)}\`` : 'unknown commit';
}

function bar(rate: number, width = 10): string {
  const filled = Math.round(Math.min(1, rate) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function header(entries: HistoryEntry[], requested: number, note?: string): string[] {
  const first = entries[0]?.at.slice(0, 16).replace('T', ' ');
  const last = entries[entries.length - 1]?.at.slice(0, 16).replace('T', ' ');
  return [`**Window:** last ${entries.length} run(s)${entries.length < requested ? ` (all recorded)` : ''}, ${first} → ${last} UTC`, ...(note ? [note] : []), ''];
}

/**
 * Local runs, plus the shared history server's runs when one is set. Without it this
 * is exactly the local history and nothing leaves the machine.
 */
async function loadEntries(root: string, requested: number, source: AnalyzeHistoryInput['source']): Promise<{ entries: HistoryEntry[]; note?: string }> {
  const settings = historySettings();
  const wanted = source ?? (settings ? 'both' : 'local');
  if (wanted === 'local') return { entries: await readHistory(root, requested) };
  if (!settings) {
    throw new PlaywrightMcpError('Cloud history needs a shared history server', 'INVALID_INPUT', {
      hint: "Set PW_MCP_HISTORY_URL and PW_MCP_HISTORY_TOKEN (self-host history-server/ from the repo, free), or use source: 'local'.",
    });
  }
  const local = wanted === 'both' ? await readHistory(root, requested) : [];
  const project = await historyProjectName(root);
  try {
    const cloud = await fetchRuns(settings, project, requested);
    const entries = mergeRuns(local, cloud, requested);
    return { entries, note: `**Source:** ${wanted === 'both' ? `${local.length} local run(s) + ` : ''}${cloud.length} shared run(s) for \`${project}\`` };
  } catch (error) {
    if (wanted === 'cloud') throw error;
    return { entries: local, note: `**Source:** local only; the history server failed: ${(error as Error).message}` };
  }
}

export const analyzeHistoryTool = {
  name: 'analyze-history',
  description:
    "Analyze the local run history (.playwright-e2e-mcp/history.jsonl, written by every run and load-report): 'flaky' ranks tests that flip pass/fail and lists broken or regressed ones; 'patterns' groups failures by cause; 'test' shows one test's timeline; 'slow' ranks durations and slowdowns; 'trend' shows stability per day; 'commits' names the commit where each failing or flaky test went bad.",
  inputSchema: analyzeHistorySchema,
  handler: async (args: AnalyzeHistoryInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('analyze-history', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const requested = args.lastRuns ?? 30;
      const limit = args.limit ?? 15;
      const view = args.view ?? (args.test ? 'test' : 'flaky');
      const loaded = await loadEntries(root, requested, args.source);
      let entries = loaded.entries;
      const sourceNote = loaded.note;

      if (entries.length === 0) {
        return toolText(
          [
            '## No run history yet',
            '',
            historyEnabled()
              ? `Runs are recorded in \`${HISTORY_DIR}/history.jsonl\` once **run-test** has run. Run the suite a few times (or use \`args: ["--repeat-each=5"]\`), then ask again.`
              : 'Recording is off (PW_MCP_HISTORY=0). Unset it to record runs.',
          ].join('\n'),
        );
      }

      if (args.test) {
        const needle = args.test.toLowerCase();
        entries = entries.map((entry) => ({
          ...entry,
          tests: entry.tests.filter((t) => `${t.file} ${t.title}`.toLowerCase().includes(needle)),
        }));
      }

      const lines: string[] = [];
      if (view === 'test') {
        const stats = testStats(entries);
        lines.push(`## Test history${args.test ? ` — "${args.test}"` : ''}`, '', ...header(entries, requested, sourceNote));
        if (stats.length === 0) {
          lines.push('_No recorded runs include a matching test._');
          return toolText(lines.join('\n'));
        }
        for (const s of stats.slice(0, limit)) {
          lines.push(
            `### ${s.title}`,
            `\`${s.file}\`${s.project ? ` · ${s.project}` : ''}`,
            '',
            `- **Timeline (oldest → newest):** ${strip(s, 40)}  (P pass · F fail · ~ passed on retry · - skipped)`,
            `- **Runs:** ${s.runs} · passed ${s.passed} · failed ${s.failed} · flaky ${s.flaky} · flips ${s.flips}`,
            `- **Average duration:** ${s.avgMs !== undefined ? formatDuration(s.avgMs) : '—'} · **last:** ${s.lastStatus} at ${s.lastAt.slice(0, 16).replace('T', ' ')}`,
          );
          const fails = entries
            .flatMap((entry) => entry.tests.filter((t) => t.title === s.title && t.file === s.file && t.msg).map((t) => t.msg!))
            .slice(-3);
          if (fails.length > 0) {
            lines.push('- **Recent errors:**');
            for (const msg of [...new Set(fails)]) lines.push(`  - ${clipLines(msg, 1, 200)}`);
          }
          lines.push('');
        }
        return toolText(lines.join('\n'));
      }

      if (view === 'patterns') {
        const patterns = failurePatterns(entries);
        lines.push('## Failure patterns', '', ...header(entries, requested, sourceNote));
        if (patterns.length === 0) {
          lines.push('✅ No failures recorded in this window.');
          return toolText(lines.join('\n'));
        }
        lines.push('| # | kind | failures | tests | example error |', '| ---: | --- | ---: | ---: | --- |');
        patterns.slice(0, limit).forEach((p, i) => {
          lines.push(`| ${i + 1} | ${p.kind} | ${p.count} | ${p.tests.length} | ${markdownCell(clipLines(p.example || p.signature, 1, 140))} |`);
        });
        lines.push('');
        const shared = patterns.filter((p) => p.tests.length > 1);
        if (shared.length > 0) {
          lines.push(
            `> 🔗 ${shared.length} pattern(s) hit several tests at once. A shared cause (a renamed element, a dead endpoint, a slow environment) usually explains them all: fix it once.`,
            '',
          );
          for (const p of shared.slice(0, 3)) {
            lines.push(`- **${clipLines(p.example || p.signature, 1, 100)}** → ${p.tests.slice(0, 5).map((t) => `\`${t}\``).join(', ')}${p.tests.length > 5 ? ` …+${p.tests.length - 5}` : ''}`);
          }
          lines.push('');
        }
        return toolText(lines.join('\n'));
      }

      if (view === 'slow') {
        const slow = slowTests(entries);
        lines.push('## Slowest tests', '', ...header(entries, requested, sourceNote));
        if (slow.length === 0) {
          lines.push('_No passing runs with durations recorded yet._');
          return toolText(lines.join('\n'));
        }
        lines.push('| # | test | runs | median | max | trend |', '| ---: | --- | ---: | ---: | ---: | --- |');
        slow.slice(0, limit).forEach((t, i) => {
          const trend = t.slowdown === undefined ? '—' : t.slowdown >= 1.25 ? `🐢 ${t.slowdown}× slower lately` : t.slowdown <= 0.8 ? `${t.slowdown}× (faster)` : 'steady';
          lines.push(`| ${i + 1} | ${markdownCell(clipLines(t.key, 1, 120))} | ${t.runs} | ${formatDuration(t.medianMs)} | ${formatDuration(t.maxMs)} | ${trend} |`);
        });
        const slowing = slow.filter((t) => (t.slowdown ?? 0) >= 1.25);
        lines.push('');
        if (slowing.length > 0) {
          lines.push(`> 🐢 ${slowing.length} test(s) got at least 25% slower in the newest third of runs. A slower test is often about to time out: check what it waits for.`);
        }
        lines.push('> Durations come from passing runs only, so a timeout does not count as slow.');
        return toolText(lines.join('\n'));
      }

      if (view === 'trend') {
        const days = dailyTrend(entries);
        lines.push('## Stability by day', '', ...header(entries, requested, sourceNote));
        lines.push('| day (UTC) | runs | tests run | failed | flaky | unstable | |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
        for (const d of days.slice(-limit)) {
          lines.push(`| ${d.day} | ${d.runs} | ${d.executions} | ${d.failed} | ${d.flaky} | ${pct(d.unstableRate)} (${d.unstableTests} tests) | ${bar(d.unstableRate)} |`);
        }
        lines.push('');
        if (days.length >= 2) {
          const first = days[0];
          const last = days[days.length - 1];
          const delta = last.unstableRate - first.unstableRate;
          lines.push(
            Math.abs(delta) < 0.02
              ? `Stability is flat: ${pct(last.unstableRate)} of test runs failed or flaked on ${last.day}, against ${pct(first.unstableRate)} on ${first.day}.`
              : delta > 0
                ? `📉 Getting worse: ${pct(last.unstableRate)} of test runs failed or flaked on ${last.day}, up from ${pct(first.unstableRate)} on ${first.day}. Use \`view: "commits"\` to see what changed.`
                : `📈 Getting better: ${pct(last.unstableRate)} of test runs failed or flaked on ${last.day}, down from ${pct(first.unstableRate)} on ${first.day}.`,
          );
        }
        return toolText(lines.join('\n'));
      }

      if (view === 'commits') {
        const breaks = breakingCommits(entries);
        lines.push('## When each test went bad', '', ...header(entries, requested, sourceNote));
        if (breaks.length === 0) {
          lines.push('✅ No test is failing or flaky now.');
          return toolText(lines.join('\n'));
        }
        const withCommit = entries.filter((e) => e.commit).length;
        if (withCommit === 0) {
          lines.push('> Runs recorded before 0.5.0 carry no commit. New runs (and reports loaded with **load-report**) record it, so this view fills in from now on.', '');
        }
        const byCommit = new Map<string, typeof breaks>();
        for (const b of breaks) {
          const key = b.firstBad.commit ?? '';
          byCommit.set(key, [...(byCommit.get(key) ?? []), b]);
        }
        const groups = [...byCommit.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [commit, items] of groups.slice(0, limit)) {
          const first = items[0].firstBad;
          lines.push(
            `### ${commit ? shortSha(commit) : 'Unknown commit'}${first.subject ? ` ${clipLines(first.subject, 1, 80)}` : ''} — ${items.length} test(s)`,
            '',
          );
          for (const b of items.slice(0, 10)) {
            const good = b.lastGood ? `last passed on ${shortSha(b.lastGood.commit)} (${b.lastGood.at.slice(0, 16).replace('T', ' ')})` : 'never passed twice in a row in this window';
            lines.push(`- ${clipLines(b.test, 1, 120)}: **${b.since}** since ${b.firstBad.at.slice(0, 16).replace('T', ' ')}; ${good}`);
          }
          if (items.length > 10) lines.push(`- …and ${items.length - 10} more`);
          lines.push('');
        }
        const top = groups[0];
        if (top && top[0] && top[1].length > 1) {
          const lastGood = top[1].find((b) => b.lastGood?.commit)?.lastGood?.commit;
          lines.push(
            `> 🔎 ${top[1].length} tests went bad on ${shortSha(top[0])}.${lastGood ? ` Compare it with the last good run: \`git diff ${lastGood.slice(0, 8)} ${top[0].slice(0, 8)}\`.` : ''}`,
          );
        }
        return toolText(lines.join('\n'));
      }

      const ranking = rankFlaky(entries);
      lines.push('## Flakiness ranking', '', ...header(entries, requested, sourceNote));
      if (ranking.flaky.length === 0 && ranking.broken.length === 0 && ranking.regressed.length === 0) {
        lines.push(`✅ No unstable tests: every recorded test behaved the same way across these runs (${ranking.stable} stable).`);
        if (entries.length < 3) lines.push('', '> Few runs recorded so far; flakiness needs repetition to show. Run the suite again or use `args: ["--repeat-each=5"]`.');
        return toolText(lines.join('\n'));
      }
      if (ranking.flaky.length > 0) {
        lines.push(
          '### ⚠️ Flaky (outcome goes back and forth)',
          '',
          '| # | test | runs | fail rate | flip rate | timeline |',
          '| ---: | --- | ---: | ---: | ---: | --- |',
        );
        ranking.flaky.slice(0, limit).forEach((s, i) => {
          lines.push(`| ${i + 1} | ${markdownCell(clipLines(s.key, 1, 120))} | ${s.runs} | ${pct(s.failRate)} | ${pct(s.flipRate)} | ${strip(s)} |`);
        });
        lines.push('');
      }
      if (ranking.regressed.length > 0) {
        lines.push('### 📉 Regressed (passed earlier, failing since)', '');
        for (const s of ranking.regressed.slice(0, limit)) lines.push(`- ${clipLines(s.key, 1, 140)} — ${strip(s)}`);
        lines.push('');
      }
      if (ranking.broken.length > 0) {
        lines.push('### ❌ Broken (failed every run)', '');
        for (const s of ranking.broken.slice(0, limit)) lines.push(`- ${clipLines(s.key, 1, 140)} — ${s.runs}/${s.runs} failed`);
        lines.push('');
      }
      lines.push(
        `${ranking.stable} other test(s) were stable.`,
        '',
        '> Next: `diagnose-flaky` on the top test for fresh evidence, `analyze-history` with `view: "patterns"` to see shared causes, or `view: "test"` for one test\'s timeline.',
      );
      return toolText(lines.join('\n'));
    }),
};
