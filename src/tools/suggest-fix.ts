/**
 * Tool 9 — suggest-fix: turn a failure from the last run into a concrete
 * patch for the spec, optionally apply it, and prove it by re-running the
 * test (reverting the file when the re-run still fails).
 *
 * Handles the three most common E2E breakages:
 * - Locator drift: the element is still on the page but its test id, text
 *   or structure changed. The broken locator's words are matched against
 *   the DOM at failure (from the Playwright trace, or a live URL), and the
 *   best match gets a Playwright locator proven unique on that page.
 * - Strict mode violations: the locator now matches several elements
 *   (a "Save" button next to "Save draft", the same link in the header and
 *   the footer). Playwright prints a unique locator for each match; the one
 *   whose name is an exact match is picked, otherwise the caller picks with
 *   `candidate`.
 * - Copy changes in text assertions (toHaveText & co): the expected string
 *   is replaced with what the page shows. That can hide a real regression,
 *   so it is applied only with allowExpectationUpdate.
 *
 * When no element plausibly matches, the tool says so: a missing element is
 * usually an app bug, and "healing" it would hide the bug.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ElementInfo, RunTestResult, TestFailure, ToolContext, ToolResponse } from '../types/index.js';
import { readFailureTrace } from '../utils/trace-reader.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectProject } from '../utils/project-detector.js';
import { recordRun } from '../utils/run-history.js';
import {
  assertRealPathInside,
  isTestFile,
  sanitizeUserPath,
  tempFilePath,
  writeFileInsideRoot,
} from '../utils/path-utils.js';
import { formatLocator, parseLocator, quote } from '../utils/locator-expr.js';
import type { LocatorCall } from '../utils/locator-expr.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import {
  assertHttpUrl,
  bestLocator,
  clipLines,
  codeFence,
  formatDuration,
  guard,
  resolveConfigSelection,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  sessionShape,
  toolText,
} from './shared.js';
import { allFailures } from './get-failure.js';

const suggestFixInput = z.object({
  index: z.number().int().min(1).optional().describe('1-based failure index (default 1)'),
  projectRoot: z.string().optional(),
  url: z.string().optional().describe('Heal against this live page instead of the trace snapshot'),
  ...sessionShape,
  apply: z.boolean().optional().describe('Write the fix (default: diff only)'),
  candidate: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Strict mode violation: which of the listed matches the test meant (1-based)'),
  verify: z.boolean().optional().describe('Re-run after applying; revert if still failing (default true)'),
  allowExpectationUpdate: z.boolean().optional().describe('Allow applying changed expected text (can hide regressions)'),
  config: z.string().optional().describe('playwright.config path or 1-based index'),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional().describe('Verification run limit (default 120000)'),
});

export type SuggestFixInput = z.infer<typeof suggestFixInput>;
export const suggestFixSchema = suggestFixInput;

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/** Pull the locator Playwright printed in the error ("Locator: …", "waiting for …"). */
export function brokenLocatorFromMessage(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  for (const line of lines) {
    const m = /(?:^|\s)(?:Locator:|waiting for)\s+((?:getBy\w+|locator)\(.*)$/.exec(line.trim());
    if (!m) continue;
    const text = m[1].trim();
    try {
      parseLocator(text);
      return text;
    } catch {
      /* not a clean expression; keep looking */
    }
  }
  return undefined;
}

export interface StrictViolation {
  /** The locator that matched more than one element, as printed. */
  locator: string;
  count: number;
  /** Each match Playwright listed: its HTML and the unique locator it printed ("aka"). */
  matches: Array<{ html: string; locator: string }>;
}

/** Parse Playwright's "strict mode violation: … resolved to N elements:" block. */
export function strictViolationFromMessage(message: string): StrictViolation | undefined {
  const head = /strict mode violation:\s+(.+?)\s+resolved to (\d+) elements:?/.exec(message);
  if (!head) return undefined;
  const matches: StrictViolation['matches'] = [];
  const tail = message.slice(head.index + head[0].length).split(/\r?\n/);
  for (const raw of tail) {
    const m = /^\s*\d+\)\s+(.*?)\s+aka\s+((?:getBy\w+|locator)\(.*)$/.exec(raw);
    if (!m) {
      if (matches.length > 0 && raw.trim() !== '' && !/^\s*\d+\)/.test(raw)) break;
      continue;
    }
    try {
      parseLocator(m[2].trim());
      matches.push({ html: m[1].trim(), locator: m[2].trim() });
    } catch {
      /* not a locator we can write back; skip it */
    }
  }
  return { locator: head[1].trim(), count: Number(head[2]), matches };
}

/** The name or text a locator's last call asks for, when it is a plain string. */
function wantedName(chain: LocatorCall[]): string | undefined {
  const last = chain[chain.length - 1];
  if (!last) return undefined;
  if (last.method === 'getByRole') {
    const options = last.args[1];
    if (options && typeof options === 'object' && 'name' in options && typeof options.name === 'string') return options.name;
    return undefined;
  }
  if (last.method !== 'locator' && typeof last.args[0] === 'string') return last.args[0];
  return undefined;
}

function isExact(chain: LocatorCall[]): boolean {
  const last = chain[chain.length - 1];
  return last.args.some((arg) => typeof arg === 'object' && arg !== null && 'exact' in arg && arg.exact === true);
}

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Which match the broken locator meant, when the evidence says so: a
 * substring name ("Save") hitting a longer one ("Save draft") means the
 * match whose name is exactly that text.
 */
export function pickStrictMatch(violation: StrictViolation): { index: number; why: string } | undefined {
  let broken: LocatorCall[];
  try {
    broken = parseLocator(violation.locator);
  } catch {
    return undefined;
  }
  const name = wantedName(broken);
  if (name === undefined || isExact(broken)) return undefined;
  const wanted = name.trim().toLowerCase();
  const exact = violation.matches
    .map((match, index) => ({ match, index, chain: parseLocator(match.locator) }))
    .filter(({ match, chain }) => {
      const candidateName = wantedName(chain);
      if (candidateName !== undefined && isExact(chain)) return candidateName.trim().toLowerCase() === wanted;
      return visibleText(match.html).toLowerCase() === wanted;
    });
  if (exact.length !== 1) return undefined;
  return {
    index: exact[0].index,
    why: `\`${violation.locator}\` matches by substring, so it also hits ${violation.count - 1} other element(s). Only match ${exact[0].index + 1} is named exactly "${name}", and Playwright reports \`${exact[0].match.locator}\` as its unique locator.`,
  };
}

/** Span of a whole locator chain on a line, from its first call to its last. */
export function findChainSpan(line: string, chain: LocatorCall[]): { start: number; end: number } | undefined {
  const first = findCallSpan(line, chain[0]);
  if (!first) return undefined;
  let end = first.end;
  for (const call of chain.slice(1)) {
    const rest = line.slice(end);
    const next = /^\s*\.\s*(\w+)\s*\(/.exec(rest);
    if (!next || next[1] !== call.method) return undefined;
    let depth = 0;
    let quoteChar: string | null = null;
    let closed = -1;
    for (let i = end + next[0].length - 1; i < line.length; i += 1) {
      const ch = line[i];
      if (quoteChar) {
        if (ch === '\\') i += 1;
        else if (ch === quoteChar) quoteChar = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quoteChar = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closed = i + 1;
          break;
        }
      }
    }
    if (closed < 0) return undefined;
    end = closed;
  }
  return { start: first.start, end };
}

const SYNONYMS: Record<string, string[]> = {
  btn: ['button'],
  nav: ['navigation'],
  img: ['image'],
  pwd: ['password'],
  msg: ['message'],
  qty: ['quantity'],
  cta: ['call', 'action'],
  submit: ['save', 'send'],
  signin: ['sign', 'login'],
  login: ['sign', 'signin'],
};

/** Words that say what kind of element it is, not which one. */
const GENERIC = new Set([
  'button', 'btn', 'link', 'input', 'field', 'text', 'label', 'icon', 'item', 'container', 'wrapper', 'div', 'span',
  'el', 'element', 'box', 'form', 'page', 'main', 'section', 'the', 'and', 'name', 'exact', 'true', 'false', 'id',
  'test', 'testid', 'data', 'role', 'heading', 'textbox', 'checkbox', 'option', 'locator', 'get', 'by', 'css',
]);

export interface HealTokens {
  /** All words to score elements with. */
  tokens: string[];
  /** The words that identify the element (what must match for a confident fix). */
  distinctive: string[];
  role?: string;
}

/** Split a broken locator into scoring words. */
export function healTokensFor(chain: LocatorCall[]): HealTokens {
  const words: string[] = [];
  let role: string | undefined;
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      words.push(
        ...value
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 1),
      );
    } else if (value && typeof value === 'object' && !('$regex' in value)) {
      for (const inner of Object.values(value)) collect(inner);
    } else if (value && typeof value === 'object' && '$regex' in value) {
      collect((value as { $regex: string }).$regex);
    }
  };
  for (const call of chain) {
    if (call.method === 'getByRole' && typeof call.args[0] === 'string') {
      role = call.args[0];
      for (const arg of call.args.slice(1)) collect(arg);
      continue;
    }
    if (call.method === 'locator' && typeof call.args[0] === 'string') {
      // Keep attribute values and ids/classes; drop CSS syntax and tag names.
      const css = call.args[0];
      const parts = [...css.matchAll(/[#.]([\w-]+)|=\s*["']?([^"'\]]+)/g)].map((m) => m[1] ?? m[2]);
      collect(parts.join(' '));
      continue;
    }
    for (const arg of call.args) collect(arg);
  }
  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(word);
    for (const syn of SYNONYMS[word] ?? []) expanded.add(syn);
  }
  const tokens = [...expanded];
  const distinctive = [...new Set(words.filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w)))];
  return { tokens, distinctive, role };
}

export interface Confidence {
  level: 'high' | 'medium' | 'none';
  matched: string[];
}

/** How sure we are that `element` is what the broken locator meant. */
export function healConfidence(element: ElementInfo, heal: HealTokens, runnerUp?: ElementInfo): Confidence {
  const hay = [
    element.id,
    element.attributes['data-testid'],
    element.attributes['data-test-id'],
    element.attributes['data-test'],
    element.attributes.name,
    element.attributes['aria-label'],
    element.attributes.placeholder,
    element.attributes.title,
    element.attributes.alt,
    element.name,
    element.text,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const words = new Set(hay.split(/[^a-z0-9]+/).filter(Boolean));
  const matched = heal.distinctive.filter(
    (token) => words.has(token) || [...words].some((w) => w.length > 2 && (w.startsWith(token) || token.startsWith(w))),
  );
  if (heal.distinctive.length === 0 || matched.length === 0) return { level: 'none', matched };
  const share = matched.length / heal.distinctive.length;
  const roleOk = heal.role === undefined || element.role === heal.role;
  const clearWinner = runnerUp === undefined || (element.score ?? 0) > (runnerUp.score ?? 0);
  if (share >= 0.5 && roleOk && clearWinner) return { level: 'high', matched };
  if (share >= 0.5 || (matched.length >= 1 && roleOk)) return { level: 'medium', matched };
  return { level: 'none', matched };
}

/** Find the source span of a locator's first call on a line, tolerant of quote style and spacing. */
export function findCallSpan(line: string, call: LocatorCall): { start: number; end: number } | undefined {
  const first = call.args[0];
  if (typeof first !== 'string') return undefined;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "(?:'|\\\\')").replace(/"/g, '(?:"|\\\\")');
  const re = new RegExp(`\\b${call.method}\\s*\\(\\s*(['"\`])${escaped}\\1`);
  const m = re.exec(line);
  if (!m) return undefined;
  // Walk to the matching close paren, skipping string contents.
  let depth = 0;
  let quoteChar: string | null = null;
  for (let i = m.index + call.method.length; i < line.length; i += 1) {
    const ch = line[i];
    if (quoteChar) {
      if (ch === '\\') i += 1;
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quoteChar = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { start: m.index, end: i + 1 };
    }
  }
  return undefined;
}

/** Line of the failing call inside `file`, from the stack ("…/file.spec.ts:18:47"). */
export function failingLine(failure: TestFailure): number | undefined {
  const text = `${failure.stack ?? ''}\n${failure.message}`;
  const base = failure.file.split('/').pop();
  if (!base) return failure.line;
  const re = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)(?::\\d+)?`, 'g');
  let found: number | undefined;
  for (const m of text.matchAll(re)) {
    found = Number(m[1]);
    break;
  }
  return found ?? failure.line;
}

/** Minimal unified diff for a single changed line. */
export function unifiedDiff(file: string, lines: string[], lineNo: number, replacement: string): string {
  const idx = lineNo - 1;
  const from = Math.max(0, idx - 2);
  const to = Math.min(lines.length, idx + 3);
  const out = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from + 1},${to - from} +${from + 1},${to - from} @@`];
  for (let i = from; i < to; i += 1) {
    if (i === idx) {
      out.push(`-${lines[i]}`, `+${replacement}`);
    } else {
      out.push(` ${lines[i]}`);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

interface Proposal {
  kind: 'locator' | 'expectation';
  confidence: 'high' | 'medium' | 'low';
  lineNo: number;
  before: string;
  after: string;
  why: string;
  alternatives?: string[];
}

const EXPECTATION_MATCHERS = /toHaveText|toContainText|toHaveTitle|toHaveValue|toHaveAttribute|toHaveURL/;

async function proposeExpectationFix(failure: TestFailure, lines: string[], lineNo: number): Promise<Proposal | undefined> {
  if (failure.expected === undefined || failure.actual === undefined) return undefined;
  if (!EXPECTATION_MATCHERS.test(failure.message)) return undefined;
  const expected = failure.expected.replace(/^"|"$/g, '');
  const actual = failure.actual.replace(/^"|"$/g, '');
  if (expected === '' || actual === '' || actual.length > 200 || /\n/.test(actual)) return undefined;
  const line = lines[lineNo - 1] ?? '';
  for (const q of ["'", '"', '`']) {
    const literal = `${q}${expected}${q}`;
    const at = line.indexOf(literal);
    if (at < 0) continue;
    const replacement = q === "'" ? quote(actual) : `${q}${actual.replace(new RegExp(q, 'g'), `\\${q}`)}${q}`;
    return {
      kind: 'expectation',
      confidence: 'low',
      lineNo,
      before: line,
      after: line.slice(0, at) + replacement + line.slice(at + literal.length),
      why: `The page shows ${JSON.stringify(actual)} where the test expects ${JSON.stringify(expected)}. Update the expectation only if that copy change was intended; otherwise this is the bug.`,
    };
  }
  return undefined;
}

function renderHeader(failure: TestFailure, index: number, total: number): string[] {
  return [
    `## 🩹 Fix for failure ${index} of ${total} — ${failure.title}`,
    '',
    `**File:** \`${failure.file}${failure.line ? `:${failure.line}` : ''}\`  |  **Kind:** \`${failure.failureKind}\``,
    '',
  ];
}

export const suggestFixTool = {
  name: 'suggest-fix',
  description:
    "Patch a failure from the last run: a drifted locator is matched against the DOM at failure (trace, or live url) and replaced with one proven unique; a locator that matches several elements (strict mode) gets the unique one for the intended match; changed copy gets the new expected text. Returns a diff and confidence; apply: true writes it, re-runs the test and reverts if still red. Refuses when the element is truly missing (app bug).",
  inputSchema: suggestFixSchema,
  handler: async (args: SuggestFixInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('suggest-fix', async () => {
      const record = ctx.store.lastRun;
      if (!record) {
        throw new PlaywrightMcpError('No test run has happened yet', 'REPORT_MISSING', {
          hint: 'Call run-test first; suggest-fix works on the failures of the most recent run.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot ?? record.projectRoot, ctx);
      const failures = await allFailures(record);
      if (failures.length === 0) return toolText('## ✅ Nothing to fix\n\nThe last run had no failures.');
      const index = Math.min(args.index ?? 1, failures.length);
      const failure = failures[index - 1];
      const out = renderHeader(failure, index, failures.length);

      if (failure.file?.endsWith('.py')) {
        out.push(
          'Automatic patches are written for TypeScript and JavaScript specs only, so this Python test is not patched. Use **get-failure** for the DOM at failure, then **inspect-page** or **validate-selector** to find the element and write the Python locator (`page.get_by_role("button", name="…")`) by hand.',
        );
        return toolText(out.join('\n'));
      }
      if (!failure.file || !isTestFile(failure.file)) {
        out.push('No spec file is attached to this failure (it is a configuration or global error), so there is nothing to patch. Use **get-failure** for the details.');
        return toolText(out.join('\n'));
      }
      const specPath = sanitizeUserPath(failure.file, root);
      await assertRealPathInside(specPath, root);
      const source = await readFile(specPath, 'utf8');
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const lines = source.split(/\r?\n/);
      const lineNo = failingLine(failure) ?? failure.line ?? 1;

      let proposal: Proposal | undefined;
      const notes: string[] = [];

      // 1. Strict mode violation: the locator matches several elements.
      const strict = strictViolationFromMessage(failure.message);
      if (strict) {
        const line = lines[lineNo - 1] ?? '';
        let brokenChain: LocatorCall[] | undefined;
        try {
          brokenChain = parseLocator(strict.locator);
        } catch {
          brokenChain = undefined;
        }
        const span = brokenChain ? findChainSpan(line, brokenChain) : undefined;
        const picked = pickStrictMatch(strict);
        const chosen =
          args.candidate !== undefined
            ? args.candidate <= strict.matches.length
              ? { index: args.candidate - 1, why: `You picked match ${args.candidate}; Playwright reports \`${strict.matches[args.candidate - 1].locator}\` as its unique locator.` }
              : undefined
            : picked;
        const listing = strict.matches.map((m, i) => `${i + 1}. \`${m.locator}\` · \`${clipLines(m.html, 1, 120)}\``);
        if (args.candidate !== undefined && !chosen) {
          throw new PlaywrightMcpError(`candidate ${args.candidate} is out of range: Playwright listed ${strict.matches.length} match(es)`, 'INVALID_INPUT', {
            hint: 'Call suggest-fix without candidate to see the list.',
          });
        }
        if (!chosen) {
          notes.push(
            `**\`${strict.locator}\` matches ${strict.count} elements** (strict mode violation), and nothing says which one the test meant:`,
            '',
            ...listing,
            '',
            'Call **suggest-fix** again with `candidate: <n>` to use that unique locator (and `apply: true` to write and verify it). If the duplicates are a bug (a dialog rendered twice, a stale list item), fix the app instead.',
          );
        } else if (!span) {
          notes.push(
            `Use \`${strict.matches[chosen.index].locator}\` for \`${strict.locator}\`, but it could not be found on line ${lineNo} of \`${failure.file}\` to patch automatically. Replace it by hand.`,
          );
        } else {
          proposal = {
            kind: 'locator',
            confidence: args.candidate !== undefined ? 'medium' : 'high',
            lineNo,
            before: line,
            after: `${line.slice(0, span.start)}${strict.matches[chosen.index].locator}${line.slice(span.end)}`,
            why: `Strict mode violation: ${chosen.why}`,
            alternatives: strict.matches.filter((_, i) => i !== chosen.index).map((m) => m.locator).slice(0, 3),
          };
        }
      }

      // 2. Locator drift.
      const brokenText = strict ? undefined : brokenLocatorFromMessage(failure.message);
      if (brokenText) {
        const chain = parseLocator(brokenText);
        const heal = healTokensFor(chain);
        let elements: ElementInfo[] = [];
        let domSource: string;
        const state = args.url ? await resolvePageState(args, root, assertHttpUrl(args.url), ctx) : {};
        let snapshotFile: string | undefined;
        try {
          if (args.url) {
            const url = assertHttpUrl(args.url);
            await assertUrlAllowed(url);
            domSource = `the live page ${url}`;
          } else {
            const trace = failure.tracePath ? await readFailureTrace(failure.tracePath, { maxHtmlChars: 2_000_000 }).catch(() => null) : null;
            if (!trace?.snapshotHtml) {
              throw new PlaywrightMcpError('The failure has no DOM snapshot to heal against', 'REPORT_MISSING', {
                hint: 'Pass `url` (plus storageState/actions if needed) so the fix is computed against the live page, or re-run the test so a trace is captured.',
              });
            }
            snapshotFile = tempFilePath('pw-mcp-snapshot', '.html');
            await writeFile(snapshotFile, trace.snapshotHtml, 'utf8');
            domSource = 'the DOM snapshot at failure (Playwright trace)';
          }
          const outcome = await runBrowserScript(
            {
              ...state,
              mode: 'heal',
              projectRoot: root,
              url: args.url ? assertHttpUrl(args.url) : undefined,
              snapshotHtmlPath: snapshotFile,
              healTokens: heal.tokens,
              healRole: heal.role,
              gotoTimeout: 30_000,
              startedAt: Date.now(),
            },
            { timeoutMs: 60_000, signal: ctx.signal },
          );
          if (!outcome.ok) {
            throw new PlaywrightMcpError(`Could not open ${domSource}: ${outcome.error ?? 'unknown error'}`, outcome.kind ?? 'UNKNOWN', {
              hint: outcome.hint,
            });
          }
          elements = outcome.data?.elements ?? [];
        } finally {
          if (snapshotFile) await rm(snapshotFile, { force: true }).catch(() => undefined);
        }

        const usable = elements.filter((element) => (element.locators?.length ?? 0) > 0);
        const best = usable[0];
        const confidence = best ? healConfidence(best, heal, usable[1]) : { level: 'none' as const, matched: [] };
        const line = lines[lineNo - 1] ?? '';
        const span = findCallSpan(line, chain[0]);

        if (!best || confidence.level === 'none') {
          notes.push(
            `**No confident replacement for \`${brokenText}\`** in ${domSource}. Nothing on the page matches ${
              heal.distinctive.length > 0 ? heal.distinctive.map((w) => `"${w}"`).join(', ') : 'its words'
            }${best ? ` (closest: \`${bestLocator(best)}\`, which shares only generic words)` : ''}.`,
            '',
            'The element is most likely **missing**, not renamed: the app did not render it (a real bug, a failed request, or a missing step before this line). Fixing the test would hide that. Check **get-failure** for failed requests and console errors first.',
          );
        } else if (!span) {
          notes.push(
            `Found the likely target: \`${bestLocator(best)}\`, but could not locate \`${formatLocator(chain.slice(0, 1))}\` on line ${lineNo} of \`${failure.file}\` to patch it automatically. Replace it by hand.`,
          );
        } else {
          const replacement = `${line.slice(0, span.start)}${bestLocator(best)}${line.slice(span.end)}`;
          proposal = {
            kind: 'locator',
            confidence: confidence.level,
            lineNo,
            before: line,
            after: replacement,
            why: `\`${brokenText}\` no longer matches anything. In ${domSource}, ${
              best.role ? `the ${best.role}${best.name ? ` "${clipLines(best.name, 1, 60)}"` : ''}` : `the <${best.tag}> element`
            } matches ${confidence.matched.map((w) => `"${w}"`).join(', ')}, and \`${bestLocator(best)}\` is proven to resolve to exactly that element.`,
            alternatives: usable
              .slice(1)
              .filter((element) => healConfidence(element, heal).level !== 'none')
              .slice(0, 2)
              .map((element) => bestLocator(element))
              .filter((value): value is string => value !== undefined),
          };
        }
      }

      // 3. Changed copy in a text/value assertion.
      if (!proposal && !strict) {
        const expectation = await proposeExpectationFix(failure, lines, lineNo);
        if (expectation) proposal = expectation;
      }

      if (!proposal) {
        if (notes.length === 0) {
          notes.push(
            `No automatic fix applies to this \`${failure.failureKind}\` failure: suggest-fix patches broken or ambiguous locators and changed expected text. Use **get-failure** for the trace, then edit by hand.`,
          );
        }
        out.push(...notes);
        return toolText(out.join('\n'));
      }

      const diff = unifiedDiff(failure.file, lines, proposal.lineNo, proposal.after);
      const fix = {
        file: failure.file,
        line: proposal.lineNo,
        before: proposal.before,
        after: proposal.after,
        kind: proposal.kind,
        confidence: proposal.confidence,
        why: proposal.why,
        ...(proposal.alternatives?.length ? { alternatives: proposal.alternatives } : {}),
      };
      out.push(
        `### Proposed ${proposal.kind === 'locator' ? 'locator fix' : 'expectation update'} — confidence **${proposal.confidence}**`,
        '',
        proposal.why,
        '',
        codeFence(diff, 'diff'),
        '',
      );
      if (proposal.alternatives && proposal.alternatives.length > 0) {
        out.push(`Other candidates: ${proposal.alternatives.map((a) => `\`${a}\``).join(', ')}`, '');
      }

      const mayApply = proposal.kind === 'locator' || args.allowExpectationUpdate === true;
      if (!args.apply) {
        out.push(
          mayApply
            ? '> Next: call **suggest-fix** again with `apply: true` to write this change and re-run the test to verify it.'
            : '> This changes what the test asserts. Apply it by hand, or pass `apply: true, allowExpectationUpdate: true` if the new text is intended.',
        );
        return toolText(out.join('\n'), { fix, applied: false });
      }
      if (!mayApply) {
        out.push('> ⛔ Not applied: expectation updates need `allowExpectationUpdate: true`, because they can hide a real regression.');
        return toolText(out.join('\n'), { fix, applied: false });
      }

      // Apply: refuse if the file changed since we read it.
      const current = await readFile(specPath, 'utf8');
      if (current !== source) {
        throw new PlaywrightMcpError(`${failure.file} changed while the fix was being computed`, 'INVALID_PATH', {
          hint: 'Call suggest-fix again to compute the fix against the current file.',
        });
      }
      const patched = [...lines];
      patched[proposal.lineNo - 1] = proposal.after;
      await writeFileInsideRoot(specPath, patched.join(eol), root);
      out.push(`**Applied** to \`${failure.file}:${proposal.lineNo}\`.`, '');

      if (args.verify === false) {
        out.push('> Not verified (verify: false). Re-run with **run-test** to check it.');
        return toolText(out.join('\n'), { fix, applied: true });
      }

      const detection = await detectProject(root);
      const configPath = resolveConfigSelection(detection, args.config);
      const target = `${specPath}${failure.line ? `:${failure.line}` : ''}`;
      let result: RunTestResult;
      try {
        result = await runTests({
          projectRoot: root,
          configPath,
          testFiles: [target],
          project: failure.project || undefined,
          retries: 0,
          retryOnFailure: false,
          timeoutMs: args.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        // The re-run could not even start: never leave an unverified edit behind.
        await writeFileInsideRoot(specPath, source, root);
        throw err;
      }
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
      await recordRun(root, result, 'suggest-fix').catch(() => undefined);

      if (result.ok) {
        out.push(`### ✅ Verified — the test passes with the fix (${formatDuration(result.durationMs)}).`);
      } else {
        await writeFileInsideRoot(specPath, source, root);
        const first = result.failures[0];
        out.push(
          `### ❌ Still failing — the change was reverted`,
          '',
          first ? codeFence(clipLines(first.message, 8, 1_200), 'text') : (result.errorMessage ?? 'The run failed without a test failure.'),
          '',
          '> The original file is restored. Call **get-failure** for the new failure, or try another candidate by hand.',
        );
      }
      return toolText(out.join('\n'), { ok: result.ok, fix, applied: result.ok, verified: result.ok });
    }),
};
