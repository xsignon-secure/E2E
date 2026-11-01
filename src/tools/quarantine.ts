/**
 * Tool — quarantine: keep a flaky test running and reported while its
 * failures stop blocking the build, with an owner, a reason and an expiry
 * date (default 14 days, at most 90). run-test and the `ci` command read
 * the list: a quarantined failure is reported but does not fail the run;
 * once the entry expires it blocks again.
 */

import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { normalizePath, relativeToRoot, sanitizeUserPath } from '../utils/path-utils.js';
import {
  addDays,
  DEFAULT_QUARANTINE_DAYS,
  isExpired,
  matchesEntry,
  MAX_QUARANTINE_DAYS,
  QUARANTINE_FILE,
  readQuarantine,
  today,
  writeQuarantine,
} from '../utils/quarantine.js';
import type { QuarantineEntry } from '../utils/quarantine.js';
import { readHistory, testStats } from '../utils/run-history.js';
import { confirmBeforeWrite, declinedResult, guard, markdownCell, resolveProjectRoot, toolText } from './shared.js';

const quarantineInput = z.object({
  action: z.enum(['list', 'add', 'remove']).optional().describe("'list' (default), 'add' or 'remove'"),
  test: z
    .string()
    .optional()
    .describe("The test as 'file › title' (as get-failure and analyze-history print it), or use file + title"),
  file: z.string().optional().describe('Spec file, relative to the project'),
  title: z.string().optional().describe("Test title, or its last parts ('Checkout › pays by card')"),
  index: z.number().int().min(1).optional().describe('add: the Nth failure of the last run instead of test/file/title'),
  owner: z.string().min(1).max(80).optional().describe('add: who will fix it (name or @handle)'),
  reason: z.string().min(3).max(300).optional().describe('add: why it is flaky, or the issue link'),
  days: z.number().int().min(1).max(MAX_QUARANTINE_DAYS).optional().describe(`add: how long it counts (default ${DEFAULT_QUARANTINE_DAYS}, max ${MAX_QUARANTINE_DAYS})`),
  projectRoot: z.string().optional().describe('Project directory (default: server root)'),
});

export type QuarantineInput = z.infer<typeof quarantineInput>;
export const quarantineSchema = quarantineInput;

function target(args: QuarantineInput, root: string, ctx: ToolContext): { file: string; title: string } {
  if (args.index !== undefined) {
    const last = ctx.store.lastRun;
    const failure = last?.projectRoot === root ? last.result.failures[args.index - 1] : undefined;
    if (!failure) {
      throw new PlaywrightMcpError(`No failure #${args.index} in the last run`, 'INVALID_INPUT', {
        hint: 'Run the tests with run-test first, or name the test with test or file + title.',
      });
    }
    return { file: failure.file, title: withoutFilePrefix(failure.file, failure.title) };
  }
  let file = args.file;
  let title = args.title;
  if (args.test) {
    const at = args.test.indexOf(' › ');
    if (at < 0) throw new PlaywrightMcpError(`test must look like 'file › title': ${args.test}`, 'INVALID_INPUT');
    file = args.test.slice(0, at);
    title = args.test.slice(at + 3).replace(/ \[[^\]]+\]$/, '');
  }
  if (!file || !title) {
    throw new PlaywrightMcpError('Name the test', 'INVALID_INPUT', { hint: "Pass test ('tests/cart.spec.ts › adds an item'), file + title, or index." });
  }
  const rel = relativeToRoot(root, sanitizeUserPath(normalizePath(file), root));
  return { file: rel, title: withoutFilePrefix(rel, title.trim()) };
}

/** Reported titles start with the spec's file name ('cart.spec.ts › adds'); the entry keeps the rest. */
function withoutFilePrefix(file: string, title: string): string {
  const prefix = `${file.split('/').pop()} › `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

/** The entry for this test, however much of the title path either side names. */
function findEntry(entries: QuarantineEntry[], test: { file: string; title: string }): QuarantineEntry | undefined {
  return entries.find((e) => matchesEntry(e, test) || matchesEntry({ ...e, title: test.title }, { file: e.file, title: e.title }));
}

function renderList(entries: QuarantineEntry[], note?: string): string {
  const lines: string[] = [];
  if (note) lines.push(note, '');
  if (entries.length === 0) {
    lines.push('## 🧊 Quarantine is empty', '', 'Add a flaky test with `action: "add"`, an owner and a reason. Its failures stop blocking runs until the entry expires.');
    return lines.join('\n');
  }
  const expired = entries.filter((e) => isExpired(e));
  lines.push(`## 🧊 ${entries.length} quarantined test${entries.length === 1 ? '' : 's'}${expired.length ? ` · ⏰ ${expired.length} expired` : ''}`, '');
  lines.push('| Test | Owner | Until | Reason |', '| --- | --- | --- | --- |');
  for (const e of entries) {
    lines.push(`| \`${markdownCell(e.file)}\` › ${markdownCell(e.title)} | ${markdownCell(e.owner)} | ${isExpired(e) ? `⏰ ${e.until}` : e.until} | ${markdownCell(e.reason)} |`);
  }
  lines.push('', `Stored in \`${QUARANTINE_FILE}\`: commit it so CI and the team use the same list. Expired entries block again.`);
  return lines.join('\n');
}

export const quarantineTool = {
  name: 'quarantine',
  description:
    "Quarantine flaky tests: they keep running and being reported, but their failures stop failing run-test and the ci command until the entry expires (default 14 days, max 90). add needs owner and reason; list shows what is quarantined and what expired; remove ends it. Stored in playwright-quarantine.json (commit it).",
  inputSchema: quarantineSchema,
  handler: async (args: QuarantineInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('quarantine', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const action = args.action ?? 'list';
      const list = await readQuarantine(root);
      if (action === 'list') {
        return toolText(renderList(list.entries), { status: 'listed', total: list.entries.length });
      }
      if (ctx.restricted) {
        throw new PlaywrightMcpError('Changing the quarantine is not available on this server', 'INVALID_PATH', {
          hint: 'It writes playwright-quarantine.json in the project. Run the server locally.',
        });
      }
      const test = target(args, root, ctx);
      const existing = findEntry(list.entries, test);

      if (action === 'remove') {
        if (!existing) {
          return toolText(renderList(list.entries, `> Nothing to remove: \`${test.file}\` › ${test.title} is not quarantined.`), { status: 'unchanged', total: list.entries.length });
        }
        const confirmed = await confirmBeforeWrite(
          ctx,
          `Remove ${existing.file} › ${existing.title} from the quarantine?`,
          `Its failures will fail runs again. Owner: ${existing.owner}. Reason: ${existing.reason}. Was until ${existing.until}.`,
        );
        if (confirmed === 'declined') return declinedResult(`removing ${existing.file} › ${existing.title} from the quarantine`, { status: 'unchanged', total: list.entries.length });
        list.entries = list.entries.filter((e) => e !== existing);
        await writeQuarantine(root, list);
        return toolText(renderList(list.entries, `> ✅ Removed \`${existing.file}\` › ${existing.title}: its failures block runs again.`), { status: 'removed', total: list.entries.length });
      }

      if (!args.owner || !args.reason) {
        throw new PlaywrightMcpError('add needs owner and reason', 'INVALID_INPUT', {
          hint: 'A quarantine without an owner is a skip nobody fixes. Name who will fix it and why it is flaky (or an issue link).',
        });
      }
      const days = args.days ?? DEFAULT_QUARANTINE_DAYS;
      const entry: QuarantineEntry = {
        file: test.file,
        title: test.title,
        owner: args.owner.trim(),
        reason: args.reason.trim(),
        until: addDays(today(), days),
        added: existing?.added ?? today(),
      };
      const confirmed = await confirmBeforeWrite(
        ctx,
        `${existing ? 'Extend the quarantine of' : 'Quarantine'} ${entry.file} › ${entry.title} until ${entry.until}?`,
        `Its failures will stop failing runs until ${entry.until} (${days} days). It still runs and is reported.\nOwner: ${entry.owner}\nReason: ${entry.reason}\nWritten to playwright-quarantine.json.`,
      );
      if (confirmed === 'declined') return declinedResult(`quarantining ${entry.file} › ${entry.title}`, { status: 'unchanged', total: list.entries.length });
      list.entries = [...list.entries.filter((e) => e !== existing), entry];
      await writeQuarantine(root, list);

      // How unstable has it been? The local history answers if it has the test.
      const history = await readHistory(root, 50).catch(() => []);
      const stats = testStats(history).find((s) => matchesEntry(entry, s));
      const evidence = stats
        ? `\n\n**History:** \`${stats.strip}\` · ${Math.round(stats.failRate * 100)}% of the last ${stats.runs} runs failed or needed a retry.`
        : '';
      const note = `> ✅ ${existing ? 'Extended' : 'Quarantined'} \`${entry.file}\` › ${entry.title} until ${entry.until} (owner ${entry.owner}). It still runs; its failures no longer fail the run.${evidence}`;
      return toolText(renderList(list.entries, note), { status: existing ? 'extended' : 'added', total: list.entries.length });
    }),
};
