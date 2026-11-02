/**
 * Tool — check-test-change (heal guard): before a test fix is kept, check
 * it did not make the test pass by checking less. Compares changed spec
 * files with a git ref (default HEAD, i.e. the uncommitted changes), or a
 * proposed new version of one file with what is on disk, and blocks
 * deleted assertions, skipped or removed tests and `.only`; warns on
 * weaker matchers, hard waits, forced clicks, swallowed errors and raised
 * timeouts or retries.
 */

import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { TestAttempt, ToolContext, ToolResponse } from '../types/index.js';
import { detectProject } from '../utils/project-detector.js';
import { runTests } from '../utils/playwright-runner.js';
import { joinProjectPath, relativeToRoot, sanitizeUserPath, toNativePath } from '../utils/path-utils.js';
import { guardFileChange, guardVerdict, isGuardedFile, renderGuardReport } from '../utils/test-change-guard.js';
import type { GuardFileResult } from '../utils/test-change-guard.js';
import { guard, resolveProjectRoot, toolText } from './shared.js';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 200;

const checkTestChangeInput = z.object({
  base: z
    .string()
    .optional()
    .describe("Git ref to compare with: 'HEAD' (default: uncommitted changes), 'origin/main' (the whole branch)"),
  files: z.array(z.string()).max(MAX_FILES).optional().describe('Only these files (default: every changed spec file and playwright config)'),
  file: z.string().optional().describe('With after: the spec file a fix would change'),
  after: z.string().max(MAX_FILE_BYTES).optional().describe("With file: the fix's full new file content, checked before it is written"),
  runtime: z
    .boolean()
    .optional()
    .describe('Also run each changed TS/JS spec in its old and new version and compare how many assertions actually ran per test (catches early returns and skipped branches the code scan cannot see)'),
  projectRoot: z.string().optional().describe('Project directory (default: server root)'),
});

export type CheckTestChangeInput = z.infer<typeof checkTestChangeInput>;
export const checkTestChangeSchema = checkTestChangeInput;

/** Refs we hand to git: no options, no shell metacharacters. */
export function assertGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!/^[\w./~^@{}-]{1,200}$/.test(trimmed) || trimmed.startsWith('-') || trimmed.includes('..')) {
    throw new PlaywrightMcpError(`Not a git ref: ${ref}`, 'INVALID_INPUT', { hint: "Use a branch, tag or commit, e.g. 'HEAD' or 'origin/main'." });
  }
  return trimmed;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: toNativePath(root), maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function readIfExists(file: string): Promise<string | undefined> {
  return readFile(toNativePath(file), 'utf8').catch(() => undefined);
}

/** Compare every changed guarded file in the working tree with `base`. */
export async function guardAgainstRef(root: string, base: string, only?: string[], befores?: Map<string, { top: string; source: string }>): Promise<GuardFileResult[]> {
  let top: string;
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim().replace(/\\/g, '/');
  } catch {
    throw new PlaywrightMcpError('Not a git repository', 'INVALID_PATH', {
      hint: 'Run it inside a git checkout, or pass file and after to check one proposed change.',
    });
  }
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    throw new PlaywrightMcpError(`Unknown git ref: ${base}`, 'INVALID_INPUT', { hint: 'Fetch it first (git fetch origin main) or use HEAD.' });
  }
  const changed = (await git(root, ['diff', '--name-only', '--no-renames', base, '--', '.']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const wanted = only?.map((f) => relativeToRoot(top, sanitizeUserPath(f, root)));
  const files = changed.filter((f) => (wanted ? wanted.includes(f) : isGuardedFile(f))).slice(0, MAX_FILES);
  const results: GuardFileResult[] = [];
  for (const file of files) {
    let before: string;
    try {
      before = await git(top, ['show', `${base}:${file}`]);
    } catch {
      continue; // a new file: nothing to weaken
    }
    if (before.length > MAX_FILE_BYTES) continue;
    const after = await readIfExists(joinProjectPath(top, file));
    results.push(guardFileChange(file, before, after));
    if (after !== undefined) befores?.set(file, { top, source: before });
  }
  return results;
}

/** The old version's temporary copy next to the spec: x.spec.ts → x.pwmcp-base.spec.ts. */
export function baseCopyName(file: string): string | undefined {
  const match = /^(.*?)(\.(?:spec|test)\.[cm]?[jt]sx?)$/.exec(file);
  return match ? `${match[1]}.pwmcp-base${match[2]}` : undefined;
}

/** Per test, how many assertions ran: before (old copy) and after (working tree). */
export function compareAssertionRuns(
  attempts: TestAttempt[],
  pairs: Array<{ file: string; copy: string }>,
): Array<{ file: string; title: string; before: number; after: number; beforeStatus: string; afterStatus: string; line?: number }> {
  const out: Array<{ file: string; title: string; before: number; after: number; beforeStatus: string; afterStatus: string; line?: number }> = [];
  for (const { file, copy } of pairs) {
    const after = attempts.filter((a) => a.file === file && a.retry === 0);
    const before = attempts.filter((a) => a.file === copy && a.retry === 0);
    for (const now of after) {
      const old = before.find((a) => a.title === now.title && a.project === now.project);
      if (!old || old.assertions === undefined || now.assertions === undefined) continue;
      out.push({ file, title: now.title, line: now.line, before: old.assertions, after: now.assertions, beforeStatus: old.status, afterStatus: now.status });
    }
  }
  return out;
}

/**
 * Run the old version of each changed spec (a temporary copy next to it,
 * removed afterwards) and the new one, and add a block finding for every
 * test that now runs fewer assertions than before. A test that failed
 * before stopped at its failure, so running fewer than that is still less.
 */
async function runtimeCheck(root: string, results: GuardFileResult[], befores: Map<string, { top: string; source: string }>, ctx: ToolContext): Promise<string> {
  const pairs: Array<{ file: string; copy: string; absCopy: string; absFile: string }> = [];
  for (const [file, { top, source }] of befores) {
    const copy = baseCopyName(file);
    if (!copy || file.endsWith('.py')) continue;
    if (pairs.length >= 10) break;
    const absCopy = joinProjectPath(top, copy);
    // wx: never overwrite a file that happens to have this name.
    const written = await writeFile(toNativePath(absCopy), source, { flag: 'wx' }).then(() => true, () => false);
    if (written) pairs.push({ file, copy, absCopy, absFile: joinProjectPath(top, file) });
  }
  if (pairs.length === 0) return '**Runtime check:** no changed TypeScript/JavaScript spec to run.';
  try {
    const detection = await detectProject(root);
    const run = await runTests({
      projectRoot: root,
      configPath: detection.configPath ?? undefined,
      testFiles: pairs.flatMap((p) => [relativeToRoot(root, p.absFile), relativeToRoot(root, p.absCopy)]),
      collectAttempts: true,
      retries: 0,
      retryOnFailure: false,
      timeoutMs: 600_000,
      signal: ctx.signal,
    });
    const rel = pairs.map((p) => ({ file: relativeToRoot(root, p.absFile), copy: relativeToRoot(root, p.absCopy), top: p.file }));
    const rows = compareAssertionRuns(run.attempts ?? [], rel);
    if (rows.length === 0) return `**Runtime check:** the tests ran but no per-test assertion counts came back${run.errorMessage ? ` (${run.errorMessage.split('\n')[0]})` : ''}.`;
    const lines = ['### Runtime check: assertions that ran', '', '| test | before | after |', '| --- | ---: | ---: |'];
    for (const row of rows) {
      lines.push(`| \`${row.file}\` ${row.title} | ${row.before} (${row.beforeStatus}) | ${row.after} (${row.afterStatus}) |`);
      if (row.after < row.before) {
        const target = results.find((r) => rel.some((p) => p.top === r.file && p.file === row.file));
        target?.findings.push({
          severity: 'block',
          rule: 'fewer-assertions-ran',
          test: row.title,
          line: row.line,
          message: `At run time the test now executes ${row.after} assertion(s), down from ${row.before}${row.beforeStatus !== 'passed' ? ' (and the old version stopped early at its failure)' : ''}: part of it no longer runs.`,
        });
      }
    }
    return lines.join('\n');
  } finally {
    for (const pair of pairs) await rm(toNativePath(pair.absCopy), { force: true }).catch(() => undefined);
  }
}

export const checkTestChangeTool = {
  name: 'check-test-change',
  description:
    "Heal guard: check that changed tests were not made to pass by checking less. Compares spec files with a git ref (default HEAD = uncommitted changes) or one proposed file (file + after). BLOCK on deleted assertions, skipped/removed tests or .only; WARN on weaker matchers, waitForTimeout, force: true, swallowed errors, raised timeouts or retries. Run it after any AI fix, before committing.",
  inputSchema: checkTestChangeSchema,
  handler: async (args: CheckTestChangeInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('check-test-change', async () => {
      if (ctx.restricted) {
        throw new PlaywrightMcpError('check-test-change is not available on this server', 'INVALID_PATH', {
          hint: 'It reads the project checkout. Run the server locally.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      let results: GuardFileResult[];
      let scope: string;
      let runtimeNote: string | undefined;
      if (args.after !== undefined || args.file) {
        if (!args.file || args.after === undefined) {
          throw new PlaywrightMcpError('Pass file and after together', 'INVALID_INPUT', {
            hint: 'Or leave both out to check the changes in the working tree against base.',
          });
        }
        const absolute = sanitizeUserPath(args.file, root);
        const before = await readIfExists(absolute);
        if (before === undefined) throw new PlaywrightMcpError(`File not found: ${args.file}`, 'INVALID_PATH');
        results = [guardFileChange(relativeToRoot(root, absolute), before, args.after)];
        scope = 'the file on disk → the proposed version';
      } else {
        const base = assertGitRef(args.base ?? 'HEAD');
        const befores = new Map<string, { top: string; source: string }>();
        results = await guardAgainstRef(root, base, args.files, befores);
        scope = base === 'HEAD' ? 'last commit → working tree' : `\`${base}\` → working tree`;
        if (args.runtime) runtimeNote = await runtimeCheck(root, results, befores, ctx);
      }
      const verdict = guardVerdict(results);
      const findings = results.flatMap((r) =>
        r.findings.map((f) => ({
          file: r.file,
          line: f.line ?? 1,
          rule: f.rule,
          severity: f.severity === 'block' ? ('high' as const) : ('medium' as const),
          message: f.message,
          ...(f.test ? { test: f.test } : {}),
        })),
      );
      const text =
        results.length === 0
          ? '## ✅ OK — no changed spec files\n\nNothing to compare: no spec file or playwright config differs from the base.'
          : renderGuardReport(results, scope) + (runtimeNote ? `\n\n${runtimeNote}` : '');
      return toolText(text, { ok: verdict !== 'BLOCK', status: verdict, findings, total: findings.length });
    }),
};
