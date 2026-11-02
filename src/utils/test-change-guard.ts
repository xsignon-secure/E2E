/**
 * Heal guard: compare a test file before and after a fix and catch the
 * changes that make a failing test pass by testing less — an assertion
 * deleted, a test skipped or removed, a matcher swapped for a weaker one,
 * a hard wait, a forced click, an error swallowed, a timeout or retry
 * count blown up.
 *
 * AI healers (Playwright's Healer agent, ours, any agent editing specs)
 * are good at turning red tests green; this is the reviewer that checks
 * they did it honestly. The scan is lexical: strings and comments are
 * masked so their words do not count, then each test(...) call is matched
 * by its describe path and title across the two versions.
 */

export type GuardSeverity = 'block' | 'warn';

export interface GuardFinding {
  severity: GuardSeverity;
  rule: string;
  /** "describe › title", or undefined for file-level findings. */
  test?: string;
  message: string;
  /** 1-based line in the new version, when the test still exists. */
  line?: number;
}

export interface GuardFileResult {
  file: string;
  findings: GuardFinding[];
  testsBefore: number;
  testsAfter: number;
}

export type GuardVerdict = 'BLOCK' | 'WARN' | 'OK';

/** Matchers that check a specific value or state. */
const STRONG = new Set([
  'toHaveText',
  'toHaveValue',
  'toHaveValues',
  'toHaveURL',
  'toHaveTitle',
  'toEqual',
  'toStrictEqual',
  'toBe',
  'toHaveCount',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveLength',
  'toHaveProperty',
  'toBeVisible',
  'toBeHidden',
  'toBeChecked',
  'toBeEnabled',
  'toBeDisabled',
  'toBeEditable',
  'toBeFocused',
  'toBeEmpty',
  'toMatch',
  'toMatchObject',
  'toMatchAriaSnapshot',
  'toHaveScreenshot',
  'toMatchSnapshot',
  'toHaveAccessibleName',
  'toHaveAccessibleDescription',
  'toHaveRole',
  'toBeInViewport',
  'toContain',
  'toContainEqual',
  'toThrow',
  'toBeOK',
]);

/** Matchers that pass for almost any value or state. */
const WEAK = new Set([
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeAttached',
  'toContainText',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeInstanceOf',
]);

/**
 * Replace the inside of strings, template literals and comments with
 * spaces (newlines kept), so positions and line numbers stay the same
 * and no word inside them looks like code.
 */
export function maskCode(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j += 1;
        else if (c !== '`' && source[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, Math.min(j, source.length));
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Index of the parenthesis closing the one at `open` in masked code, or -1. */
function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return c === ')' ? i : -1;
    }
  }
  return -1;
}

/** Index of the brace closing the one at `open` in masked code, or -1. */
function closingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) return c === '}' ? i : -1;
    }
  }
  return -1;
}

/**
 * Measure the try statements in masked code: `unsafe` counts tries whose
 * catch neither rethrows nor asserts (a try/finally, or a catch that
 * throws, still fails the test); `swallowedAssertions` counts the unsafe
 * ones that wrap an assertion, which can then never fail.
 */
export function tryShapes(masked: string): { unsafe: number; swallowedAssertions: number } {
  let unsafe = 0;
  let swallowedAssertions = 0;
  for (const match of masked.matchAll(/\btry\s*\{/g)) {
    const open = match.index! + match[0].length - 1;
    const close = closingBrace(masked, open);
    if (close < 0) continue;
    const handler = /^\s*catch\s*(?:\([^)]*\)\s*)?\{/.exec(masked.slice(close + 1));
    if (!handler) continue; // try/finally: the error still propagates
    const catchOpen = close + 1 + handler[0].length - 1;
    const catchClose = closingBrace(masked, catchOpen);
    if (catchClose < 0) continue;
    const catchBody = masked.slice(catchOpen + 1, catchClose);
    if (/\bthrow\b|\bexpect\s*\(|\btest\.fail\s*\(/.test(catchBody)) continue;
    unsafe += 1;
    if (/\bexpect(?:\.soft|\.poll)?\s*\(/.test(masked.slice(open, close))) swallowedAssertions += 1;
  }
  return { unsafe, swallowedAssertions };
}

/** Matchers that return a promise (web-first assertions on a locator, page or response). */
const ASYNC_MATCHERS = new Set([
  'toBeAttached',
  'toBeChecked',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFocused',
  'toBeHidden',
  'toBeInViewport',
  'toBeVisible',
  'toBeOK',
  'toContainText',
  'toHaveAccessibleDescription',
  'toHaveAccessibleName',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveRole',
  'toHaveScreenshot',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
  'toHaveValues',
  'toMatchAriaSnapshot',
]);

/**
 * Count web-first assertions used as a bare statement without `await`:
 * the test moves on (and can finish) before they settle, so they never
 * fail it. Only statement-start calls count; an expect handed to
 * Promise.all, assigned or returned is left alone.
 */
export function unawaitedAssertions(masked: string): number {
  let n = 0;
  for (const match of masked.matchAll(/\bexpect(\.soft|\.poll)?\s*\(/g)) {
    const at = match.index!;
    if (masked[at - 1] === '.') continue;
    let k = at - 1;
    while (k >= 0 && /\s/.test(masked[k])) k -= 1;
    const prev = k < 0 ? ';' : masked[k];
    if (prev !== ';' && prev !== '{' && prev !== '}') continue; // await / return / argument / assignment
    const open = at + match[0].length - 1;
    const close = closingParen(masked, open);
    if (close < 0) continue;
    const rest = /^\s*(?:\.\s*not\s*)?\.\s*(to[A-Z]\w*)\s*\(/.exec(masked.slice(close + 1));
    if (!rest) continue;
    if (match[1] === '.poll' || ASYNC_MATCHERS.has(rest[1])) n += 1;
  }
  return n;
}

/** The string literal starting at `at` in the original source (after whitespace), or undefined. */
function stringArgument(source: string, at: number): string | undefined {
  let i = at;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let j = i + 1;
  let text = '';
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\' && j + 1 < source.length) {
      text += source[j + 1];
      j += 2;
      continue;
    }
    text += source[j];
    j += 1;
  }
  return text;
}

interface Block {
  title: string;
  start: number;
  end: number;
  modifier?: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

export interface TestShape {
  key: string;
  title: string;
  line: number;
  modifier?: string;
  assertions: number;
  soft: number;
  conditionalSkips: number;
  hardWaits: number;
  forced: number;
  swallowed: number;
  tries: number;
  /** try blocks around an assertion whose catch neither rethrows nor asserts. */
  swallowedAssertions: number;
  /** Web-first assertions left without `await`. */
  unawaited: number;
  /** Assertions that only run when a condition holds (inside an if, after && / ?). */
  conditional: number;
  /** `return` statements with an assertion after them in the test. */
  earlyReturns: number;
  maxTimeout: number;
  strong: number;
  weak: number;
  body: string;
}

export interface FileShape {
  tests: Map<string, TestShape>;
  only: number;
  describeSkips: number;
  maxRetries: number;
  maxDiffAllowance: number;
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function maxNumber(text: string, re: RegExp): number {
  let max = 0;
  for (const match of text.matchAll(re)) {
    const value = Number(match[match.length - 1].replace(/_/g, ''));
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/** Regions of masked code that run only when a condition holds: if/else bodies. */
function conditionalRegions(masked: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const bodyAt = (from: number): [number, number] | undefined => {
    let k = from;
    while (k < masked.length && /\s/.test(masked[k])) k += 1;
    if (masked[k] === '{') {
      const end = closingBrace(masked, k);
      return end < 0 ? undefined : [k, end];
    }
    const semi = masked.indexOf(';', k);
    return semi < 0 ? undefined : [k, semi];
  };
  for (const match of masked.matchAll(/\bif\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    const close = closingParen(masked, open);
    if (close < 0) continue;
    const body = bodyAt(close + 1);
    if (!body) continue;
    regions.push(body);
    const elseMatch = /^\s*else\b(?!\s+if\b)/.exec(masked.slice(body[1] + 1));
    if (elseMatch) {
      const other = bodyAt(body[1] + 1 + elseMatch[0].length);
      if (other) regions.push(other);
    }
  }
  return regions;
}

/** Count assertions that run only under a condition. */
export function conditionalAssertions(masked: string): number {
  const regions = conditionalRegions(masked);
  let n = 0;
  for (const match of masked.matchAll(/\bexpect(?:\.soft|\.poll)?\s*\(/g)) {
    const at = match.index!;
    if (masked[at - 1] === '.') continue;
    const before = masked.slice(Math.max(0, at - 40), at).replace(/\s+$/, '');
    const shortCircuit = /(?:&&|\|\||\?\?|\?|:)\s*(?:await\s*)?$/.test(before) && !/\b(?:case|default)\s*:?\s*$/.test(before);
    if (shortCircuit || regions.some(([from, to]) => at > from && at < to)) n += 1;
  }
  return n;
}

/** Count `return` statements that have an assertion somewhere after them in the body. */
export function earlyReturns(masked: string): number {
  const lastExpect = Math.max(-1, ...[...masked.matchAll(/\bexpect(?:\.soft|\.poll)?\s*\(/g)].map((m) => m.index!));
  return [...masked.matchAll(/\breturn\b/g)].filter((m) => m.index! < lastExpect).length;
}

/** Find every test(...) and describe(...) with a string title, and measure each test. */
export function shapeOf(source: string): FileShape {
  const masked = maskCode(source);
  const describes: Block[] = [];
  const tests: Block[] = [];
  const re = /\b(test|it)((?:\.describe)?)(?:\.(only|skip|fixme|fail|slow|serial|parallel))?\s*\(/g;
  const describeRe = /\b(?:test\.)?describe(?:\.(only|skip|fixme|serial|parallel))?\s*\(/g;
  for (const match of masked.matchAll(describeRe)) {
    const open = match.index! + match[0].length - 1;
    const title = stringArgument(source, open + 1);
    const end = closingParen(masked, open);
    if (title !== undefined && end > 0) describes.push({ title, start: match.index!, end, modifier: match[1] });
  }
  for (const match of masked.matchAll(re)) {
    if (match[2]) continue; // test.describe(...) is handled above
    const before = masked.slice(Math.max(0, match.index! - 1), match.index!);
    if (before === '.') continue; // something.test(...)
    const open = match.index! + match[0].length - 1;
    const title = stringArgument(source, open + 1);
    if (title === undefined) continue; // test.skip(condition) inside a body
    const end = closingParen(masked, open);
    if (end < 0) continue;
    tests.push({ title, start: match.index!, end, modifier: match[3] });
  }

  const shapes = new Map<string, TestShape>();
  for (const block of tests) {
    const path = describes
      .filter((d) => d.start < block.start && d.end > block.end)
      .sort((a, b) => a.start - b.start)
      .map((d) => d.title);
    let key = [...path, block.title].join(' › ');
    while (shapes.has(key)) key += ' (again)';
    const body = masked.slice(block.start, block.end + 1);
    const matchers = [...body.matchAll(/\.(to[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
    const trying = tryShapes(body);
    shapes.set(key, {
      key,
      title: block.title,
      line: lineOf(source, block.start),
      modifier: block.modifier,
      assertions: count(body, /\bexpect(?:\.soft|\.poll)?\s*\(/g),
      soft: count(body, /\bexpect\.soft\s*\(/g),
      conditionalSkips: count(body, /\btest\.(?:skip|fixme)\s*\(/g),
      hardWaits: count(body, /\.waitForTimeout\s*\(/g),
      forced: count(body, /\bforce\s*:\s*true\b/g),
      swallowed: count(body, /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0|false|true)\s*\)/g),
      tries: trying.unsafe,
      swallowedAssertions: trying.swallowedAssertions,
      unawaited: unawaitedAssertions(body),
      conditional: conditionalAssertions(body),
      earlyReturns: earlyReturns(body),
      maxTimeout: maxNumber(body, /(?:\btimeout\s*:\s*|\bsetTimeout\s*\(\s*)([\d_]+)/g),
      strong: matchers.filter((m) => STRONG.has(m)).length,
      weak: matchers.filter((m) => WEAK.has(m)).length,
      body: body.replace(/\s+/g, ' '),
    });
  }
  return {
    tests: shapes,
    only: tests.filter((t) => t.modifier === 'only').length + describes.filter((d) => d.modifier === 'only').length,
    describeSkips: describes.filter((d) => d.modifier === 'skip' || d.modifier === 'fixme').length,
    maxRetries: maxNumber(masked, /\bretries\s*:\s*([\d_]+)/g),
    maxDiffAllowance: Math.max(
      maxNumber(masked, /\bmaxDiffPixels\s*:\s*([\d_]+)/g),
      maxNumber(masked, /\bmaxDiffPixelRatio\s*:\s*(0?\.\d+|\d+)/g) * 1_000_000,
      maxNumber(masked, /\bthreshold\s*:\s*(0?\.\d+|\d+)/g) * 1_000_000,
    ),
  };
}

/** Compare two versions of one file. */
export function guardFileChange(file: string, beforeSource: string, afterSource: string | undefined): GuardFileResult {
  const measure = file.endsWith('.py') ? pythonShapeOf : shapeOf;
  const before = measure(beforeSource);
  const findings: GuardFinding[] = [];
  if (afterSource === undefined) {
    if (before.tests.size > 0) {
      findings.push({
        severity: 'block',
        rule: 'file-deleted',
        message: `The file was deleted with its ${before.tests.size} test${before.tests.size === 1 ? '' : 's'}.`,
      });
    }
    return { file, findings, testsBefore: before.tests.size, testsAfter: 0 };
  }
  const after = measure(afterSource);

  const removed = [...before.tests.values()].filter((t) => !after.tests.has(t.key));
  const added = [...after.tests.values()].filter((t) => !before.tests.has(t.key));
  const renamed = new Map<string, TestShape>();
  for (const old of removed) {
    const twin = added.find((t) => ![...renamed.values()].includes(t) && t.body.replace(/^\S+\s*\(\s*/, '') === old.body.replace(/^\S+\s*\(\s*/, ''));
    const similar =
      twin ??
      added.find(
        (t) =>
          ![...renamed.values()].includes(t) &&
          t.assertions >= old.assertions &&
          t.strong >= old.strong &&
          Math.abs(t.body.length - old.body.length) < Math.max(80, old.body.length * 0.2),
      );
    if (similar && removed.length === added.length) renamed.set(old.key, similar);
  }

  for (const old of removed) {
    const now = renamed.get(old.key);
    if (now) {
      compareTest(old, now, findings);
      continue;
    }
    findings.push({ severity: 'block', rule: 'test-removed', test: old.key, message: `Test removed (it had ${old.assertions} assertion${old.assertions === 1 ? '' : 's'}).` });
  }
  for (const [key, old] of before.tests) {
    const now = after.tests.get(key);
    if (now) compareTest(old, now, findings);
  }

  if (after.only > before.only) {
    findings.push({ severity: 'block', rule: 'only-added', message: '`.only` was added: every other test in the run is silently skipped.' });
  }
  if (after.describeSkips > before.describeSkips) {
    findings.push({ severity: 'block', rule: 'skip-added', message: 'A whole describe block was marked skip or fixme.' });
  }
  if (after.maxRetries > before.maxRetries) {
    findings.push({
      severity: 'warn',
      rule: 'retries-raised',
      message: `Retries raised from ${before.maxRetries} to ${after.maxRetries}: a flaky test passing on retry is still flaky.`,
    });
  }
  if (after.maxDiffAllowance > before.maxDiffAllowance && before.maxDiffAllowance >= 0 && after.maxDiffAllowance > 0) {
    findings.push({
      severity: 'warn',
      rule: 'screenshot-tolerance-raised',
      message: 'A screenshot comparison now tolerates more differences (maxDiffPixels, maxDiffPixelRatio or threshold went up).',
    });
  }
  return { file, findings, testsBefore: before.tests.size, testsAfter: after.tests.size };
}

function compareTest(old: TestShape, now: TestShape, findings: GuardFinding[]): void {
  const where = { test: now.key === old.key ? now.key : `${old.key} → ${now.key}`, line: now.line };
  if ((now.modifier === 'skip' || now.modifier === 'fixme') && old.modifier !== now.modifier) {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: `Test marked \`${now.modifier}\`: it no longer runs.` });
  }
  if (now.modifier === 'fail' && old.modifier !== 'fail') {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: 'Test marked `fail`: it now passes when it fails.' });
  }
  if (now.conditionalSkips > old.conditionalSkips) {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: 'A `test.skip()` / `test.fixme()` call was added inside the test.' });
  }
  if (now.assertions < old.assertions) {
    findings.push({
      severity: 'block',
      rule: 'assertions-removed',
      ...where,
      message: `Assertions went from ${old.assertions} to ${now.assertions}.`,
    });
  } else if (now.soft > old.soft) {
    findings.push({
      severity: 'warn',
      rule: 'assertion-softened',
      ...where,
      message: 'A hard `expect` became `expect.soft`: the test keeps going after it fails.',
    });
  }
  if (now.strong < old.strong && now.weak > old.weak) {
    findings.push({
      severity: 'warn',
      rule: 'weaker-matcher',
      ...where,
      message: 'A specific matcher (toHaveText, toBeVisible, toEqual…) was swapped for a looser one (toBeTruthy, toBeAttached, toContainText…).',
    });
  }
  if (now.hardWaits > old.hardWaits) {
    findings.push({ severity: 'warn', rule: 'hard-wait-added', ...where, message: '`waitForTimeout` was added: it hides the race instead of waiting for the condition.' });
  }
  if (now.forced > old.forced) {
    findings.push({ severity: 'warn', rule: 'force-added', ...where, message: '`force: true` was added: the click skips the checks that catch a covered or disabled element.' });
  }
  if (now.swallowedAssertions > old.swallowedAssertions) {
    findings.push({
      severity: 'block',
      rule: 'assertion-swallowed',
      ...where,
      message: 'An assertion was wrapped in `try` with a `catch` that neither rethrows nor asserts: it can no longer fail the test.',
    });
  } else if (now.swallowed > old.swallowed || now.tries > old.tries) {
    findings.push({ severity: 'warn', rule: 'error-swallowed', ...where, message: 'A `try` without a rethrow, or an empty `.catch()`, was added: a failing step can now pass silently.' });
  }
  if (now.conditional > old.conditional) {
    const moved = now.assertions - now.conditional < old.assertions - old.conditional;
    findings.push({
      severity: moved ? 'block' : 'warn',
      rule: 'assertion-made-conditional',
      ...where,
      message: moved
        ? 'An assertion now sits inside an `if` (or after `&&` / `?`): when the condition is false it never runs, so the test passes without checking.'
        : 'A new assertion runs only under a condition (`if`, `&&`, `?`): check the test still fails when the condition is false.',
    });
  }
  if (now.earlyReturns > old.earlyReturns) {
    findings.push({
      severity: 'warn',
      rule: 'early-return',
      ...where,
      message: 'A `return` was added before later assertions: when it is taken, the rest of the test never runs.',
    });
  }
  if (now.unawaited > old.unawaited) {
    findings.push({
      severity: 'warn',
      rule: 'assertion-not-awaited',
      ...where,
      message: 'A web-first assertion (toBeVisible, toHaveText…) is missing `await`: the test can finish before it settles, so it never fails.',
    });
  }
  if (now.maxTimeout > Math.max(old.maxTimeout * 2, 30_000)) {
    findings.push({
      severity: 'warn',
      rule: 'timeout-raised',
      ...where,
      message: `A timeout went up to ${now.maxTimeout} ms${old.maxTimeout ? ` (was ${old.maxTimeout})` : ''}: waiting longer rarely fixes the cause.`,
    });
  }
}

export function guardVerdict(results: GuardFileResult[]): GuardVerdict {
  const all = results.flatMap((r) => r.findings);
  if (all.some((f) => f.severity === 'block')) return 'BLOCK';
  if (all.length > 0) return 'WARN';
  return 'OK';
}

/** Spec files and Playwright configs, the files the guard reads. */
export function isGuardedFile(file: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(file) || /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(file) || /(^|\/)(e2e|tests?)\/.*\.[cm]?[jt]sx?$/.test(file);
}

/** Markdown report shared by the tool and the CLI. */
export function renderGuardReport(results: GuardFileResult[], scope: string): string {
  const verdict = guardVerdict(results);
  const findings = results.flatMap((r) => r.findings.map((f) => ({ ...f, file: r.file })));
  const blocks = findings.filter((f) => f.severity === 'block').length;
  const warns = findings.length - blocks;
  const lines: string[] = [];
  if (verdict === 'BLOCK') lines.push(`## 🛑 BLOCK — ${blocks} change${blocks === 1 ? '' : 's'} make tests check less`);
  else if (verdict === 'WARN') lines.push(`## ⚠️ WARN — ${warns} change${warns === 1 ? '' : 's'} to review`);
  else lines.push('## ✅ OK — no test was weakened');
  lines.push('', `**Compared:** ${scope} · ${results.length} file${results.length === 1 ? '' : 's'}`, '');
  if (findings.length === 0) {
    lines.push('Assertions, skips, waits, timeouts and retries are the same or stricter in every changed test.');
    return lines.join('\n');
  }
  for (const f of findings) {
    const at = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`- ${f.severity === 'block' ? '🛑' : '⚠️'} \`${at}\`${f.test ? ` · ${f.test}` : ''} — ${f.message}`);
  }
  lines.push(
    '',
    verdict === 'BLOCK'
      ? '**What to do:** a fix that makes a test pass by checking less hides the bug it was written to catch. Restore the assertion (or the test) and fix the locator, the wait or the app instead. If removing it is intended, say so in the PR and rerun the guard with that file excluded.'
      : '**What to do:** each of these can be right, but each can also hide a real failure. Check the reason before merging.',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* pytest-playwright                                                   */
/* ------------------------------------------------------------------ */

/** Mask Python strings (all quote styles, prefixes included) and # comments. */
export function maskPython(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) {
        if (source[j] === '\\') j += 1;
        else if (!triple && source[j] === '\n') break;
        j += 1;
      }
      blank(i + quote.length, Math.min(j, source.length));
      i = j + quote.length;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of the block that starts at `start` (the `def`/`if` line itself included). */
function pyBlock(lines: string[], start: number): { end: number; text: string } {
  const indent = indentOf(lines[start]);
  let end = start;
  for (let k = start + 1; k < lines.length; k += 1) {
    if (lines[k].trim() === '') continue;
    if (indentOf(lines[k]) <= indent) break;
    end = k;
  }
  return { end, text: lines.slice(start, end + 1).join('\n') };
}

/** Decorators directly above line `at`. */
function decoratorsAbove(lines: string[], at: number): string {
  const out: string[] = [];
  for (let k = at - 1; k >= 0; k -= 1) {
    const t = lines[k].trim();
    if (t.startsWith('@')) out.push(t);
    else if (t !== '') break;
  }
  return out.join('\n');
}

const PY_ASSERT = /\bexpect\s*\(|^\s*assert\b/gm;

function pyConditionalAssertions(lines: string[]): number {
  let n = 0;
  const inside = new Set<number>();
  lines.forEach((line, k) => {
    if (/^\s*(if|elif|else)\b.*:\s*$/.test(line)) {
      const block = pyBlock(lines, k);
      for (let m = k + 1; m <= block.end; m += 1) inside.add(m);
    }
  });
  lines.forEach((line, k) => {
    const asserts = (line.match(/\bexpect\s*\(|^\s*assert\b/g) ?? []).length;
    if (asserts === 0) return;
    if (inside.has(k) || /\bif\b.*\bexpect\s*\(|\band\s+expect\s*\(|\bexpect\s*\(.*\bif\b.*\belse\b/.test(line)) n += asserts;
  });
  return n;
}

function pyTries(lines: string[]): { unsafe: number; swallowedAssertions: number; passes: number } {
  let unsafe = 0;
  let swallowedAssertions = 0;
  let passes = 0;
  lines.forEach((line, k) => {
    if (!/^\s*try\s*:\s*$/.test(line)) return;
    const tryBlock = pyBlock(lines, k);
    let next = tryBlock.end + 1;
    while (next < lines.length && lines[next].trim() === '') next += 1;
    if (next >= lines.length || !/^\s*except\b/.test(lines[next])) return;
    const handler = pyBlock(lines, next);
    const body = handler.text.split('\n').slice(1).join('\n');
    if (/\braise\b|\bexpect\s*\(|^\s*assert\b|pytest\.fail\s*\(/m.test(body)) return;
    unsafe += 1;
    if (/^\s*pass\s*$/m.test(body)) passes += 1;
    if (/\bexpect\s*\(|^\s*assert\b/m.test(tryBlock.text)) swallowedAssertions += 1;
  });
  return { unsafe, swallowedAssertions, passes };
}

const snakeToCamel = (name: string): string => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** The pytest version of shapeOf: test functions (and Test classes), with the same measures. */
export function pythonShapeOf(source: string): FileShape {
  const masked = maskPython(source);
  const lines = masked.split('\n');
  const shapes = new Map<string, TestShape>();
  let describeSkips = 0;
  let maxRetries = 0;
  const classes: Array<{ name: string; indent: number; end: number }> = [];
  lines.forEach((line, k) => {
    const cls = /^(\s*)class\s+(\w+)/.exec(line);
    if (cls) {
      classes.push({ name: cls[2], indent: cls[1].length, end: pyBlock(lines, k).end });
      if (/pytest\.mark\.(skip|skipif|xfail)\b/.test(decoratorsAbove(lines, k))) describeSkips += 1;
    }
  });
  if (/^pytestmark\s*=.*pytest\.mark\.(skip|skipif)\b/m.test(masked)) describeSkips += 1;
  for (const match of masked.matchAll(/\breruns\s*=\s*(\d+)/g)) maxRetries = Math.max(maxRetries, Number(match[1]));

  lines.forEach((line, k) => {
    const def = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
    if (!def) return;
    const block = pyBlock(lines, k);
    const bodyLines = lines.slice(k, block.end + 1);
    const body = block.text;
    const decorators = decoratorsAbove(lines, k);
    const owner = classes.filter((c) => c.indent < def[1].length && k > 0 && k <= c.end).map((c) => c.name);
    let key = [...owner, def[2]].join(' › ');
    while (shapes.has(key)) key += ' (again)';
    const modifier = /pytest\.mark\.(skip|skipif)\b/.test(decorators) ? 'skip' : /pytest\.mark\.xfail\b/.test(decorators) ? 'fail' : undefined;
    for (const rerun of decorators.matchAll(/reruns\s*=\s*(\d+)/g)) maxRetries = Math.max(maxRetries, Number(rerun[1]));
    const matchers = [...body.matchAll(/\.(to_[a-z_]+|not_to_[a-z_]+)\s*\(/g)].map((m) => snakeToCamel(m[1].replace(/^not_/, '')));
    const tries = pyTries(bodyLines);
    const assertLines = [...body.matchAll(PY_ASSERT)].length;
    const lastAssert = Math.max(-1, ...[...body.matchAll(PY_ASSERT)].map((m) => m.index!));
    shapes.set(key, {
      key,
      title: def[2],
      line: k + 1,
      modifier,
      assertions: assertLines,
      soft: 0,
      conditionalSkips: count(body, /\bpytest\.(?:skip|xfail)\s*\(/g),
      hardWaits: count(body, /\.wait_for_timeout\s*\(|\btime\.sleep\s*\(|\bsleep\s*\(/g),
      forced: count(body, /\bforce\s*=\s*True\b/g),
      swallowed: tries.passes,
      tries: tries.unsafe,
      swallowedAssertions: tries.swallowedAssertions,
      unawaited: 0,
      conditional: pyConditionalAssertions(bodyLines),
      earlyReturns: [...body.matchAll(/^\s*return\b/gm)].filter((m) => m.index! < lastAssert).length,
      maxTimeout: maxNumber(body, /\btimeout\s*=\s*([\d_]+)/g),
      strong: matchers.filter((m) => STRONG.has(m)).length,
      weak: matchers.filter((m) => WEAK.has(m)).length,
      body: body.replace(/^\s*(?:async\s+)?def\s+\w+/, '').replace(/\s+/g, ' '),
    });
  });
  return { tests: shapes, only: 0, describeSkips, maxRetries, maxDiffAllowance: 0 };
}
