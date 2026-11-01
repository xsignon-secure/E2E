/**
 * Structured results: every tool returns, next to its Markdown, a JSON
 * object (`structuredContent`) described by an output schema, so agents
 * and apps can read verdicts, counts and file:line positions without
 * parsing prose.
 *
 * All results share an envelope (`ok`, and `error` when the call failed);
 * the tools agents chain most also fill in their own fields. Every field
 * past `ok` is optional, so a tool may add detail without breaking older
 * readers.
 */

import { z } from 'zod';
import type { RunTestResult, TestFailure } from '../types/index.js';

const failureSchema = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  title: z.string(),
  project: z.string().optional(),
  kind: z.string(),
  message: z.string(),
  tracePath: z.string().optional(),
});

const runSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  flaky: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number(),
  exitCode: z.number().int().nullable(),
  partial: z.boolean(),
  failures: z.array(failureSchema),
  failuresTruncated: z.boolean().optional(),
  quarantined: z.number().int().optional().describe('failures covered by an active quarantine entry (they do not fail the run)'),
});

const errorSchema = z.object({ kind: z.string(), message: z.string(), hint: z.string().optional() });

const verdictSchema = z.enum(['NOT REPRODUCING', 'FLAKY', 'CONSISTENTLY FAILING', 'NO TESTS RAN']);

const fixSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  before: z.string(),
  after: z.string(),
  kind: z.enum(['locator', 'expectation']),
  confidence: z.string(),
  why: z.string(),
  alternatives: z.array(z.string()).optional(),
});

/** Output schema shared by every tool: the envelope plus each tool's fields. */
export const toolOutputSchema = z.object({
  ok: z.boolean().describe('false when the call failed (see error) or the tests it ran failed'),
  error: errorSchema.optional(),
  // run-test, get-run-status
  run: runSchema.optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  // get-failure
  failure: failureSchema.extend({ expected: z.string().optional(), actual: z.string().optional() }).optional(),
  index: z.number().int().optional(),
  total: z.number().int().optional(),
  // list-tests
  tests: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().optional(),
        title: z.string(),
        project: z.string().optional(),
        verdict: verdictSchema.optional(),
        passed: z.number().int().optional(),
        failed: z.number().int().optional(),
      }),
    )
    .optional(),
  truncated: z.boolean().optional(),
  // diagnose-flaky
  verdict: verdictSchema.optional(),
  // suggest-fix
  fix: fixSchema.optional(),
  applied: z.boolean().optional(),
  verified: z.boolean().optional(),
  // audit-accessibility
  violations: z
    .array(z.object({ id: z.string(), impact: z.string(), help: z.string(), helpUrl: z.string(), count: z.number().int() }))
    .optional(),
  // audit-performance
  metrics: z
    .array(
      z.object({
        id: z.enum(['lcp', 'cls', 'inp', 'tbt', 'fcp', 'ttfb']),
        value: z.number().optional(),
        unit: z.enum(['ms', 'score']),
        rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
        budget: z.number().optional(),
        overBudget: z.boolean(),
      }),
    )
    .optional(),
  url: z.string().optional(),
  // audit-tests
  findings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int(),
        rule: z.string(),
        severity: z.enum(['high', 'medium', 'low']),
        message: z.string(),
        fix: z.string().optional().describe('the replacement line, when the fix is mechanical'),
        test: z.string().optional(),
      }),
    )
    .optional(),
  // bisect-failure
  firstBad: z
    .object({ sha: z.string(), subject: z.string(), author: z.string(), date: z.string(), files: z.array(z.string()) })
    .optional(),
  steps: z
    .array(z.object({ commit: z.string(), verdict: z.enum(['good', 'bad', 'skip']), note: z.string().optional() }))
    .optional(),
  // validate-selector, inspect-page
  valid: z.boolean().optional().describe('validate-selector: the selector parsed and ran'),
  matches: z.number().int().optional().describe('elements matched; actions need exactly 1'),
  locator: z.string().optional().describe('a verified unique locator for the first match'),
  httpStatus: z.number().int().optional().describe("the page's HTTP status"),
  // tools that change files: the person said no, so nothing was written
  declined: z.boolean().optional().describe('the person declined the change; nothing was written'),
  // save-login
  path: z.string().optional().describe('save-login: the storageState file, relative to the project'),
  expiresAt: z.string().optional().describe('save-login: when the first session cookie expires (ISO)'),
});

export type StructuredResult = z.infer<typeof toolOutputSchema>;

/** Keep long messages short: an agent that wants all of it calls get-failure. */
function firstLines(text: string, lines = 6, chars = 600): string {
  const head = text.split('\n').slice(0, lines).join('\n');
  return head.length > chars ? `${head.slice(0, chars)}…` : head;
}

export function failureData(failure: TestFailure): z.infer<typeof failureSchema> {
  return {
    file: failure.file,
    ...(failure.line !== undefined ? { line: failure.line } : {}),
    title: failure.title,
    ...(failure.project ? { project: failure.project } : {}),
    kind: failure.failureKind,
    message: firstLines(failure.message ?? ''),
    ...(failure.tracePath ? { tracePath: failure.tracePath } : {}),
  };
}

export function runData(result: RunTestResult): z.infer<typeof runSchema> {
  const stats = result.stats;
  return {
    passed: stats?.expected ?? 0,
    failed: stats?.unexpected ?? result.failures.length,
    flaky: stats?.flaky ?? 0,
    skipped: stats?.skipped ?? 0,
    durationMs: Math.round(result.durationMs),
    exitCode: result.exitCode,
    partial: result.partial,
    failures: result.failures.map(failureData),
    ...(result.failuresTruncated ? { failuresTruncated: true } : {}),
  };
}

/** The fields each tool fills in, beyond the envelope (ok, error). */
const TOOL_FIELDS: Readonly<Record<string, ReadonlyArray<keyof StructuredResult>>> = {
  'run-test': ['run', 'runId', 'status'],
  'get-run-status': ['run', 'runId', 'status'],
  'get-failure': ['failure', 'index', 'total'],
  'list-tests': ['tests', 'total', 'truncated'],
  'diagnose-flaky': ['verdict', 'tests'],
  'suggest-fix': ['fix', 'applied', 'verified', 'declined'],
  'audit-accessibility': ['url', 'violations'],
  'audit-performance': ['url', 'metrics'],
  'audit-tests': ['findings', 'total', 'truncated', 'applied', 'verified'],
  'bisect-failure': ['status', 'firstBad', 'steps'],
  'validate-selector': ['url', 'valid', 'matches', 'locator', 'httpStatus'],
  'save-login': ['status', 'valid', 'path', 'url', 'expiresAt'],
  'check-test-change': ['status', 'findings', 'total'],
  quarantine: ['status', 'total', 'declined'],
};

/**
 * The output schema for one tool: the envelope plus only that tool's fields,
 * so tools/list does not repeat every tool's fields nineteen times. Tools
 * with no fields of their own declare none (their results still carry the
 * envelope): each schema is context a client pays for on every request.
 */
export function outputSchemaFor(toolName: string) {
  const fields = TOOL_FIELDS[toolName];
  if (!fields) return undefined;
  const mask: Partial<Record<keyof StructuredResult, true>> = { ok: true, error: true };
  for (const field of fields) mask[field] = true;
  return toolOutputSchema.pick(mask as Record<keyof StructuredResult, true>);
}
