/**
 * Flake-risk rules for Playwright test code: patterns that make tests
 * pass or fail by timing rather than by what the app does (hard waits,
 * assertions that read once instead of retrying, promises nobody awaits,
 * selectors tied to layout). Each finding says why it is risky, and the
 * mechanical ones carry the replacement line.
 *
 * The scan is line based, not a TypeScript parse: it skips comments and
 * aims for few false alarms over catching every case.
 */

export type FlakeSeverity = 'high' | 'medium' | 'low';

export type FlakeRule =
  | 'hard-wait'
  | 'sleep'
  | 'non-retrying-assertion'
  | 'missing-await'
  | 'focused-test'
  | 'force-action'
  | 'networkidle'
  | 'element-handle'
  | 'fragile-selector'
  | 'no-timeout'
  | 'hardcoded-url'
  | 'serial-mode'
  | 'act-before-hydration';

export interface FlakeFinding {
  file: string;
  line: number;
  rule: FlakeRule;
  severity: FlakeSeverity;
  message: string;
  /** The source line, trimmed. */
  code: string;
  /** The whole replacement line when the fix is mechanical. */
  fix?: string;
  /** Title of the test the line belongs to, when one encloses it. */
  test?: string;
}

export const SEVERITY_WEIGHT: Readonly<Record<FlakeSeverity, number>> = { high: 5, medium: 2, low: 1 };

export const RULES: Readonly<Record<FlakeRule, { severity: FlakeSeverity; message: string }>> = {
  'hard-wait': {
    severity: 'high',
    message: 'Fixed wait: too short on a slow run, wasted time on a fast one. Wait for the state instead (a web-first assertion, waitForURL or waitForResponse).',
  },
  sleep: {
    severity: 'high',
    message: 'setTimeout sleep: the same problem as waitForTimeout, hidden from Playwright. Wait for the state instead.',
  },
  'non-retrying-assertion': {
    severity: 'high',
    message: 'Reads the page once and asserts on the value, so it fails if the page is a moment late. A web-first assertion retries until it holds.',
  },
  'missing-await': {
    severity: 'high',
    message: 'Not awaited: the test moves on (or ends) before this finishes, so a failure is lost or lands in another step.',
  },
  'focused-test': {
    severity: 'high',
    message: '.only left in: every other test in the run is skipped (and forbidOnly fails CI).',
  },
  'force-action': {
    severity: 'medium',
    message: 'force: true skips the actionability checks, so the action can hit a covered, moving or disabled element that a user could not.',
  },
  networkidle: {
    severity: 'medium',
    message: "networkidle waits for 500 ms without traffic, which polling, analytics or websockets can stop from ever happening. Playwright discourages it; wait for what the test needs.",
  },
  'element-handle': {
    severity: 'medium',
    message: 'ElementHandle API: the handle goes stale when the page re-renders. Locators re-resolve on every use.',
  },
  'fragile-selector': {
    severity: 'medium',
    message: 'Selector tied to layout or generated class names: it breaks when markup moves. Prefer getByRole, getByLabel, getByText or getByTestId.',
  },
  'no-timeout': {
    severity: 'medium',
    message: 'timeout: 0 means wait forever: a missed state hangs the run until the global timeout instead of failing at this step.',
  },
  'hardcoded-url': {
    severity: 'low',
    message: 'Hard-coded local URL: set baseURL in the config and goto a path, so the test runs against any environment.',
  },
  'act-before-hydration': {
    severity: 'medium',
    message: "First action right after goto on a server-rendered app: the HTML is clickable before hydration attaches its handlers, so the click or fill can be lost. Wait for a sign the app is interactive first, e.g. `await expect(page.locator('html[data-hydrated]')).toBeAttached()` (set by a root effect), and do it in a beforeEach or fixture.",
  },
  'serial-mode': {
    severity: 'low',
    message: 'Serial mode: tests depend on each other, so one failure skips the rest and retries re-run the whole group.',
  },
};

/* ------------------------------------------------------------------ */
/* Small parsing helpers                                               */
/* ------------------------------------------------------------------ */

/** Index of the bracket closing the one at `open`, skipping quoted strings; -1 if unbalanced. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits `target.method(args)` into its parts when `expr` ends in a call. */
function trailingCall(expr: string): { target: string; method: string; args: string } | undefined {
  const trimmed = expr.trim();
  if (!trimmed.endsWith(')')) return undefined;
  // Walk back to the call's opening parenthesis.
  for (let open = trimmed.lastIndexOf('('); open >= 0; open = trimmed.lastIndexOf('(', open - 1)) {
    if (matchBracket(trimmed, open) !== trimmed.length - 1) continue;
    const head = /\.(\w+)\s*$/.exec(trimmed.slice(0, open));
    if (!head) return undefined;
    return { target: trimmed.slice(0, head.index), method: head[1], args: trimmed.slice(open + 1, -1).trim() };
  }
  return undefined;
}

const STATE_MATCHERS: Readonly<Record<string, string>> = {
  isVisible: 'toBeVisible',
  isHidden: 'toBeHidden',
  isEnabled: 'toBeEnabled',
  isDisabled: 'toBeDisabled',
  isChecked: 'toBeChecked',
  isEditable: 'toBeEditable',
};

/**
 * The web-first form of a one-shot assertion, e.g.
 * `expect(await x.isVisible()).toBe(true)` → `await expect(x).toBeVisible()`.
 * Returns the whole rewritten line, or undefined when the line is not one
 * this knows how to rewrite.
 */
export function webFirstRewrite(line: string): string | undefined {
  const start = /\bexpect\(/.exec(line);
  if (!start) return undefined;
  const open = start.index + 'expect'.length;
  const close = matchBracket(line, open);
  if (close < 0) return undefined;
  const inner = line.slice(open + 1, close).trim();
  const after = line.slice(close + 1);
  const assertion = /^\s*\.(not\.)?(toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toContain)\(/.exec(after);
  if (!assertion) return undefined;
  const argsOpen = assertion[0].length - 1;
  const argsClose = matchBracket(after, argsOpen);
  if (argsClose < 0) return undefined;
  const expected = after.slice(argsOpen + 1, argsClose).trim();
  const tail = after.slice(argsClose + 1);
  let negated = Boolean(assertion[1]);
  const matcher = assertion[2];
  const equality = matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual';

  let target: string;
  let web: string;
  let webArgs = '';
  if (/^page\.url\(\)$/.test(inner)) {
    if (!equality) return undefined;
    target = 'page';
    web = 'toHaveURL';
    webArgs = expected;
  } else {
    if (!inner.startsWith('await ')) return undefined;
    const call = trailingCall(inner.slice('await '.length));
    if (!call || call.target.trim() === '') return undefined;
    target = call.target.trim();
    if (STATE_MATCHERS[call.method] && call.args === '') {
      if (matcher === 'toBeTruthy' || (equality && expected === 'true')) web = STATE_MATCHERS[call.method];
      else if (matcher === 'toBeFalsy' || (equality && expected === 'false')) {
        web = STATE_MATCHERS[call.method];
        negated = !negated;
      } else return undefined;
    } else if ((call.method === 'textContent' || call.method === 'innerText') && call.args === '') {
      if (equality) web = 'toHaveText';
      else if (matcher === 'toContain') web = 'toContainText';
      else return undefined;
      webArgs = expected;
    } else if (call.method === 'inputValue' && call.args === '' && equality) {
      web = 'toHaveValue';
      webArgs = expected;
    } else if (call.method === 'count' && call.args === '' && equality) {
      web = 'toHaveCount';
      webArgs = expected;
    } else if (call.method === 'getAttribute' && call.args !== '' && equality) {
      web = 'toHaveAttribute';
      webArgs = `${call.args}, ${expected}`;
    } else if (call.method === 'title' && call.args === '' && target === 'page' && equality) {
      web = 'toHaveTitle';
      webArgs = expected;
    } else return undefined;
  }
  const prefix = line.slice(0, start.index);
  const awaited = /\bawait\s*$/.test(prefix) ? prefix : `${prefix}await `;
  return `${awaited}expect(${target})${negated ? '.not' : ''}.${web}(${webArgs})${tail}`;
}

const ASYNC_MATCHERS =
  /\.(?:not\.)?(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeChecked|toBeEditable|toBeFocused|toBeAttached|toBeInViewport|toBeEmpty|toHaveText|toContainText|toHaveValue|toHaveValues|toHaveCount|toHaveAttribute|toHaveClass|toContainClass|toHaveCSS|toHaveId|toHaveJSProperty|toHaveURL|toHaveTitle|toHaveScreenshot|toMatchAriaSnapshot|toHaveAccessibleName|toHaveAccessibleDescription|toHaveRole|toPass)\(/;

const PAGE_ACTIONS =
  /\.(goto|click|dblclick|fill|press|pressSequentially|type|check|uncheck|setChecked|selectOption|setInputFiles|hover|tap|focus|blur|clear|reload|goBack|goForward|waitForURL|waitForLoadState|dragTo|dragAndDrop|setViewportSize|screenshot)\(/;

const TEST_TITLE = /\btest(?:\.(?:only|fixme|skip|slow|fail))?\(\s*(['"`])((?:\\.|(?!\1).)+)\1/;

function selectorRisk(selector: string): boolean {
  const s = selector.trim();
  if (/^(xpath=|\/\/|\(\/\/|\.\.\/)/.test(s)) return true;
  if (/:nth-(child|of-type)\(/.test(s)) return true;
  // Hashed class names from CSS-in-JS and CSS modules.
  if (/\.(css|sc|jsx|emotion)-[a-z0-9]{5,}/i.test(s) || /\.[A-Za-z]+_[A-Za-z]+__[A-Za-z0-9]{5}/.test(s)) return true;
  // A long chain of descendant or child steps.
  const steps = s.replace(/\[[^\]]*\]|\([^)]*\)|"[^"]*"|'[^']*'/g, '').split(/\s*>\s*|\s+/).filter(Boolean);
  return steps.length >= 4;
}

/** The statement starting at `index`: that line plus following lines until one ends it (at most six). */
function statementFrom(lines: string[], index: number): string {
  const parts: string[] = [];
  for (let i = index; i < lines.length && i < index + 6; i += 1) {
    parts.push(lines[i].trim());
    if (/[;{}]\s*$/.test(lines[i]) || (i > index && lines[i].trim() === '')) break;
  }
  return parts.join(' ');
}

/** Scan one spec file's source. `file` is only copied into the findings. */
/** Dependencies that make an app render on the server and hydrate in the browser. */
const SSR_PACKAGES: ReadonlyArray<[string, string]> = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/react', 'Remix'],
  ['@react-router/dev', 'React Router'],
  ['astro', 'Astro'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['gatsby', 'Gatsby'],
  ['@angular/ssr', 'Angular SSR'],
  ['@builder.io/qwik-city', 'Qwik'],
  ['solid-start', 'SolidStart'],
  ['@solidjs/start', 'SolidStart'],
];

/** The server-rendering framework a package.json depends on, if any (Qwik resumes, so it is left out). */
export function ssrFramework(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined): string | undefined {
  const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const hit = SSR_PACKAGES.find(([name]) => name in deps);
  return hit && hit[1] !== 'Qwik' ? hit[1] : undefined;
}

export interface FlakeScanOptions {
  /** The app is server-rendered (by this framework): check for actions before hydration. */
  ssr?: string;
}

export function scanFlakeRisks(file: string, source: string, options: FlakeScanOptions = {}): FlakeFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: FlakeFinding[] = [];
  let inBlockComment = false;
  let currentTest: string | undefined;
  let afterGoto = false;

  const add = (index: number, rule: FlakeRule, fix?: string): void => {
    const lineText = lines[index];
    findings.push({
      file,
      line: index + 1,
      rule,
      severity: RULES[rule].severity,
      message: RULES[rule].message,
      code: lineText.trim(),
      ...(fix !== undefined && fix !== lineText ? { fix } : {}),
      ...(currentTest ? { test: currentTest } : {}),
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // Drop a trailing line comment (not `://` inside a URL).
    const code = raw.replace(/(^|[^:'"`])\/\/.*$/, '$1');

    const title = TEST_TITLE.exec(code);
    if (title && !/\btest\.(describe|step|use|beforeEach|afterEach|beforeAll|afterAll|extend)\b/.test(code)) currentTest = title[2];

    if (options.ssr) {
      // A full navigation, then the first thing done is an input action
      // with nothing in between that waits for the app to be interactive.
      if (title) afterGoto = false;
      if (/\bexpect\b|\.waitFor\w*\(|\.toBe\w*\(/.test(code)) afterGoto = false;
      else if (afterGoto && /\.(click|dblclick|tap|fill|type|pressSequentially|press|check|uncheck|setChecked|selectOption)\(/.test(code)) {
        add(i, 'act-before-hydration');
        afterGoto = false;
      }
      if (/\.(goto|reload)\(/.test(code) && !/waitUntil\s*:\s*['"`]networkidle/.test(code)) afterGoto = true;
    }

    if (/\.waitForTimeout\(/.test(code)) add(i, 'hard-wait');
    if (/new Promise\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\(/.test(code) || /\bsetTimeout\(\s*\w+\s*,\s*\d+\s*\)\s*\)/.test(code)) add(i, 'sleep');

    if (/\bexpect\(\s*(await\s+[^;]*\.(isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable|textContent|innerText|inputValue|count|getAttribute)\(|page\.url\(\)\s*\)\s*\.(not\.)?(toBe|toEqual|toStrictEqual)\()/.test(code)) {
      add(i, 'non-retrying-assertion', webFirstRewrite(raw));
    } else if (/^(expect(\.soft)?\(|expect\.poll\()/.test(trimmed)) {
      const statement = statementFrom(lines, i);
      if (trimmed.startsWith('expect.poll(') || ASYNC_MATCHERS.test(statement)) {
        add(i, 'missing-await', raw.replace(/^(\s*)/, '$1await '));
      }
    } else if (/^page\.\w/.test(trimmed)) {
      const statement = statementFrom(lines, i);
      if (PAGE_ACTIONS.test(statement) && !/,\s*$/.test(statement) && !/^page\.(on|once|off|route|unroute)\(/.test(trimmed)) {
        add(i, 'missing-await', raw.replace(/^(\s*)/, '$1await '));
      }
    }

    if (/\b(test|describe)(\.describe)?\.only\(/.test(code)) add(i, 'focused-test', raw.replace(/\.only\(/, '('));
    if (/\bforce\s*:\s*true\b/.test(code)) add(i, 'force-action');
    if (/['"`]networkidle['"`]/.test(code)) add(i, 'networkidle');
    if (/\bpage\.(\$|\$\$|\$eval|\$\$eval)\(|\.waitForSelector\(|\.elementHandles?\(/.test(code)) add(i, 'element-handle');
    for (const m of code.matchAll(/(?:\.locator|\.\$\$?|waitForSelector)\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g)) {
      if (selectorRisk(m[2])) {
        add(i, 'fragile-selector');
        break;
      }
    }
    if (/\btimeout\s*:\s*0\b/.test(code) || /setTimeout\(\s*0\s*\)|setDefaultTimeout\(\s*0\s*\)/.test(code)) add(i, 'no-timeout');
    if (/\.goto\(\s*['"`]https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/'"`]/.test(code)) add(i, 'hardcoded-url');
    if (/mode\s*:\s*['"`]serial['"`]/.test(code)) add(i, 'serial-mode');
  }
  return findings;
}

/** Apply every finding's fix to the source, line by line. Findings must belong to this source. */
export function applyFlakeFixes(source: string, findings: FlakeFinding[]): { source: string; applied: FlakeFinding[] } {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const applied: FlakeFinding[] = [];
  const done = new Set<number>();
  for (const finding of findings) {
    if (finding.fix === undefined || done.has(finding.line)) continue;
    if (lines[finding.line - 1]?.trim() !== finding.code) continue;
    lines[finding.line - 1] = finding.fix;
    done.add(finding.line);
    applied.push(finding);
  }
  return { source: lines.join(eol), applied };
}
