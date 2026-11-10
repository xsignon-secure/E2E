/**
 * `playwright-e2e-mcp ci`: the same diagnosis the MCP tools give an agent,
 * as a plain command for CI. It runs the suite (auto-retry once, so flaky
 * tests are reported as flaky rather than failed), optionally repeats the
 * failures through diagnose-flaky and drafts suggest-fix diffs, and writes
 * one Markdown report: to stdout, to --output, and to the GitHub job
 * summary when GITHUB_STEP_SUMMARY is set.
 *
 * Exit codes: 0 all passed (flaky allowed), 1 tests failed, 2 the run
 * itself failed (no Playwright, config error, timeout) or bad arguments.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { createToolStore } from '../tools/shared.js';
import { withholdFromChildren } from '../utils/playwright-runner.js';
import { runTestTool } from '../tools/run-test.js';
import { diagnoseFlakyTool } from '../tools/diagnose-flaky.js';
import { suggestFixTool } from '../tools/suggest-fix.js';
import type { StructuredResult } from '../tools/structured.js';
import { postSuggestionReview, pullRequestFromEnv } from './review.js';
import type { FixSuggestion } from './review.js';

export const CI_USAGE = [
  'Usage: playwright-e2e-mcp ci [options] [test files…]',
  '',
  'Runs the Playwright suite and writes a Markdown diagnosis (stdout, --output,',
  'and $GITHUB_STEP_SUMMARY when set). Exit 0 = passed, 1 = tests failed, 2 = run error.',
  '',
  '  --project-root <dir>   project directory (default: PW_MCP_PROJECT_ROOT or cwd)',
  '  --config <path|n>      playwright.config path or 1-based index',
  '  --browser <name>       chromium | firefox | webkit',
  '  --grep <regex>         only tests whose title matches',
  '  --workers <n>          Playwright workers',
  '  --timeout <ms>         wall-clock limit for the run (default 600000)',
  '  --no-retry             do not auto-retry failures once',
  '  --flaky-runs <n>       repeat failing tests n times (2-10) for a flaky verdict',
  '  --suggest <n>          draft suggest-fix diffs for the first n failures (max 5)',
  '  --output <file>        also write the report to this file (for a PR comment)',
  '  --verify-fixes         apply each suggested fix, re-run its test, then restore the file',
  '  --suggestions <file>   write the suggested fixes as JSON (repository-relative paths)',
  '  --review               on a GitHub pull request, post the fixes as suggested changes',
  '                         (needs GITHUB_TOKEN or GH_TOKEN with pull-requests: write)',
  '',
].join('\n');

export interface CiOptions {
  projectRoot?: string;
  config?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  grep?: string;
  workers?: number;
  timeoutMs: number;
  retry: boolean;
  flakyRuns?: number;
  suggest: number;
  output?: string;
  verifyFixes: boolean;
  suggestions?: string;
  review: boolean;
  testFiles: string[];
}

function intOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** Parse `ci` arguments (everything after the subcommand). Throws on bad input. */
export function parseCiArgs(argv: string[]): CiOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'project-root': { type: 'string' },
      config: { type: 'string' },
      browser: { type: 'string' },
      grep: { type: 'string' },
      workers: { type: 'string' },
      timeout: { type: 'string' },
      'no-retry': { type: 'boolean' },
      'flaky-runs': { type: 'string' },
      suggest: { type: 'string' },
      output: { type: 'string' },
      'verify-fixes': { type: 'boolean' },
      suggestions: { type: 'string' },
      review: { type: 'boolean' },
    },
  });
  const browser = values.browser;
  if (browser !== undefined && browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') {
    throw new Error('--browser must be chromium, firefox or webkit');
  }
  return {
    projectRoot: values['project-root'],
    config: values.config,
    browser,
    grep: values.grep,
    workers: intOption(values.workers, 'workers', 1, 64),
    timeoutMs: intOption(values.timeout, 'timeout', 1_000, 3_600_000) ?? 600_000,
    retry: values['no-retry'] !== true,
    flakyRuns: intOption(values['flaky-runs'], 'flaky-runs', 2, 10),
    suggest: intOption(values.suggest, 'suggest', 0, 5) ?? 0,
    output: values.output,
    verifyFixes: values['verify-fixes'] === true,
    suggestions: values.suggestions,
    review: values.review === true,
    testFiles: positionals,
  };
}

function text(response: ToolResponse): string {
  return response.content.map((block) => block.text).join('\n');
}

function structured(response: ToolResponse): StructuredResult | undefined {
  return response.structuredContent as StructuredResult | undefined;
}

/** Put the original line back after a verification run applied a fix. */
async function restoreLine(file: string, line: number, before: string, after: string): Promise<void> {
  const source = await readFile(file, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines[line - 1] !== after) return;
  lines[line - 1] = before;
  await writeFile(file, lines.join(eol), 'utf8');
}

/** A project-relative file as a repository-relative posix path, or undefined outside the repository. */
export function repoPath(projectRoot: string, file: string, repoRoot: string): string | undefined {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(projectRoot, file));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

/** Run the CI flow; returns the exit code. */
export async function runCi(argv: string[]): Promise<number> {
  let options: CiOptions;
  try {
    options = parseCiArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${CI_USAGE}`);
    return 2;
  }

  // The token is for posting the review; the tests a PR changed must not get it.
  withholdFromChildren(['GITHUB_TOKEN', 'GH_TOKEN']);

  const projectRoot = options.projectRoot ?? process.env.PW_MCP_PROJECT_ROOT ?? process.cwd();
  const ctx: ToolContext = {
    // Info logs would bury the report in CI output; LOG_LEVEL still wins.
    logger: createLogger({
      level: process.env.LOG_LEVEL || process.env.MCP_LOG_LEVEL ? undefined : 'warn',
      bindings: { name: 'playwright-e2e-mcp', mode: 'ci' },
    }),
    store: createToolStore(),
    projectRoot,
  };

  const sections: string[] = [];
  const run = await runTestTool.handler(
    {
      testFiles: options.testFiles.length > 0 ? options.testFiles : undefined,
      grep: options.grep,
      browser: options.browser,
      workers: options.workers,
      timeoutMs: options.timeoutMs,
      retryOnFailure: options.retry,
      config: options.config,
    },
    ctx,
  );
  sections.push(text(run));

  const result = ctx.store.lastRun?.result;
  const failures = result?.failures ?? [];
  let code = result === undefined || run.isError ? 2 : result.ok ? 0 : failures.length > 0 ? 1 : 2;
  // Every failure is quarantined (and none expired): report them, pass the build.
  if (code === 1 && (structured(run)?.run?.quarantined ?? 0) > 0 && structured(run)?.ok === true) code = 0;

  const fixes: FixSuggestion[] = [];
  const suggest = options.review || options.suggestions ? Math.max(options.suggest, 1) : options.suggest;
  if (code === 1 && suggest > 0 && ctx.store.lastRun) {
    // Before diagnose-flaky, which replaces the last run suggest-fix indexes into.
    // A verification run replaces it too, so each fix starts from the suite run.
    const suiteRun = ctx.store.lastRun;
    const count = Math.min(suggest, suiteRun.result.failures.length);
    for (let index = 1; index <= count; index += 1) {
      ctx.store.setLastRun(suiteRun);
      const response = await suggestFixTool.handler({ index, config: options.config }, ctx);
      let section = text(response).replace(/^## /m, '### ');
      const fix = structured(response)?.fix;
      let verified = false;
      if (fix && options.verifyFixes) {
        ctx.store.setLastRun(suiteRun);
        const trial = await suggestFixTool.handler(
          { index, config: options.config, apply: true, allowExpectationUpdate: true },
          ctx,
        );
        verified = structured(trial)?.verified === true;
        // A passing fix stays written by suggest-fix; CI only reports it.
        if (verified) await restoreLine(path.resolve(projectRoot, fix.file), fix.line, fix.before, fix.after);
        section += verified
          ? '\n\n✅ **Verified in CI:** the test passes with this change.'
          : '\n\n⚠️ **Not verified:** the test still failed with this change in CI.';
      }
      sections.push(section);
      const failure = suiteRun.result.failures[index - 1];
      const target = fix ? repoPath(projectRoot, fix.file, process.env.GITHUB_WORKSPACE ?? projectRoot) : undefined;
      if (fix && target && (verified || !options.verifyFixes)) {
        fixes.push({
          path: target,
          line: fix.line,
          before: fix.before,
          after: fix.after,
          kind: fix.kind,
          confidence: fix.confidence,
          why: fix.why,
          verified,
          test: failure?.title ?? fix.file,
        });
      }
    }
    ctx.store.setLastRun(suiteRun);
  }

  if (options.suggestions) {
    try {
      await writeFile(options.suggestions, `${JSON.stringify(fixes, null, 2)}\n`, 'utf8');
    } catch (err) {
      process.stderr.write(`could not write the suggestions: ${(err as Error).message}\n`);
    }
  }
  if (options.review && fixes.length > 0) {
    const pr = await pullRequestFromEnv();
    if (!pr) {
      process.stderr.write('--review: not a pull_request run, or no GITHUB_TOKEN/GH_TOKEN; fixes stay in the report.\n');
    } else {
      const review = await postSuggestionReview(fixes, pr);
      if (review.error) process.stderr.write(`::warning::Could not post suggested fixes: ${review.error}\n`);
      else if (review.posted.length > 0) {
        sections.push(
          `💡 Posted ${review.posted.length === 1 ? 'a suggested change' : `${review.posted.length} suggested changes`} on this PR: use **Commit suggestion** to apply.`,
        );
      }
      if (review.outsideDiff.length > 0) {
        process.stderr.write(`${review.outsideDiff.length} fix(es) are on lines this PR did not change, so they are only in the report.\n`);
      }
    }
  }

  if (code === 1 && options.flakyRuns) {
    const flaky = await diagnoseFlakyTool.handler({ runs: options.flakyRuns, config: options.config, browser: options.browser }, ctx);
    sections.push(text(flaky).replace(/^## /m, '### '));
  }

  const report = `${sections.join('\n\n---\n\n')}\n\n<sub>Generated by [playwright-e2e-mcp](https://github.com/xsignon-secure/E2E) \`ci\`.</sub>\n`;
  process.stdout.write(report);
  try {
    if (options.output) await writeFile(options.output, report, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8');
  } catch (err) {
    process.stderr.write(`could not write the report: ${(err as Error).message}\n`);
    code = Math.max(code, 2);
  }
  return code;
}
