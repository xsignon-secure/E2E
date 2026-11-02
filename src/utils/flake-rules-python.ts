/**
 * Flake-risk rules for pytest-playwright test files (test_*.py, *_test.py):
 * the same rules as for TypeScript, in Python's spelling. Hard waits
 * (`wait_for_timeout`, `time.sleep`), one-shot `assert x.is_visible()`
 * instead of a retrying `expect(x).to_be_visible()`, actions an async test
 * forgets to await, `force=True`, `networkidle`, element handles, layout
 * selectors, `timeout=0` and hard-coded local URLs.
 *
 * Line based like the TypeScript scan; it skips comments and docstrings and
 * aims for few false alarms. One-shot assertions carry a mechanical rewrite
 * when the file already imports `expect`.
 */

import { RULES } from './flake-rules.js';
import type { FlakeFinding, FlakeRule } from './flake-rules.js';

/** True when a filename looks like a pytest test module. */
export function isPythonTestFile(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  return /^test_.*\.py$/i.test(base) || /^.+_test\.py$/i.test(base);
}

const PY_MESSAGES: Partial<Record<FlakeRule, string>> = {
  'hard-wait': 'Fixed wait: too short on a slow run, wasted time on a fast one. Wait for the state instead (expect(...), page.wait_for_url or page.expect_response).',
  sleep: 'time.sleep / asyncio.sleep: the same problem as wait_for_timeout, hidden from Playwright. Wait for the state instead.',
  'non-retrying-assertion': 'Reads the page once and asserts on the value, so it fails if the page is a moment late. expect(locator) retries until it holds.',
  'missing-await': 'Not awaited in an async test: the coroutine never runs (Python warns "was never awaited") and the step silently does nothing.',
  'force-action': 'force=True skips the actionability checks, so the action can hit a covered, moving or disabled element that a user could not.',
  'element-handle': 'ElementHandle API (query_selector, wait_for_selector): the handle goes stale when the page re-renders. Locators re-resolve on every use.',
  'fragile-selector': 'Selector tied to layout or generated class names: it breaks when markup moves. Prefer get_by_role, get_by_label, get_by_text or get_by_test_id.',
  'no-timeout': 'timeout=0 means wait forever: a missed state hangs the run until the global timeout instead of failing at this step.',
  'hardcoded-url': 'Hard-coded local URL: pass --base-url (pytest-base-url) and goto a path, so the test runs against any environment.',
};

/** Methods whose one-shot result is asserted, and the web-first matcher for each. */
const STATE: Record<string, string> = {
  is_visible: 'to_be_visible',
  is_hidden: 'to_be_hidden',
  is_enabled: 'to_be_enabled',
  is_disabled: 'to_be_disabled',
  is_checked: 'to_be_checked',
  is_editable: 'to_be_editable',
};
const VALUE: Record<string, string> = {
  inner_text: 'to_have_text',
  text_content: 'to_have_text',
  input_value: 'to_have_value',
  count: 'to_have_count',
};

const ONE_SHOT = /^\s*assert\s+(not\s+)?(await\s+)?\S.*\.(is_visible|is_hidden|is_enabled|is_disabled|is_checked|is_editable|inner_text|text_content|input_value|count|get_attribute)\(/;
const URL_ASSERT = /^\s*assert\s+page\.url\s*==/;

const ACTIONS =
  /\.(goto|click|dblclick|fill|press|press_sequentially|type|check|uncheck|set_checked|select_option|set_input_files|hover|tap|focus|blur|clear|reload|go_back|go_forward|wait_for_url|wait_for_load_state|drag_to|drag_and_drop|set_viewport_size|screenshot)\(/;

/** Index of the bracket closing the one at `open`, skipping quoted strings; -1 if unbalanced. */
function closeBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The `expect(...)` form of a one-shot assertion line, e.g.
 * `assert page.get_by_text("Saved").is_visible()` →
 * `expect(page.get_by_text("Saved")).to_be_visible()`. Undefined when the
 * line is not a form this knows how to rewrite.
 */
export function pythonWebFirstRewrite(line: string): string | undefined {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  let body = line.trim().replace(/\s+#.*$/, '');
  if (!body.startsWith('assert ')) return undefined;
  body = body.slice('assert '.length).trim();
  if (/,\s*(['"]|f['"])/.test(body) && !/==/.test(body)) return undefined; // assert x, "message"
  let negated = false;
  if (body.startsWith('not ')) {
    negated = true;
    body = body.slice(4).trim();
  }
  const awaited = body.startsWith('await ');
  if (awaited) body = body.slice(6).trim();
  const prefix = `${indent}${awaited ? 'await ' : ''}`;

  const url = /^page\.url\s*==\s*(.+)$/.exec(body);
  if (url && !negated && !awaited) return `${indent}expect(page).to_have_url(${url[1].trim()})`;

  // target.method(args) [== expected]
  const method = /\.(is_visible|is_hidden|is_enabled|is_disabled|is_checked|is_editable|inner_text|text_content|input_value|count|get_attribute)\(/.exec(body);
  if (!method) return undefined;
  // The last such call on the line is the one asserted.
  const at = body.lastIndexOf(`.${method[1]}(`);
  const target = body.slice(0, at);
  const open = at + method[1].length + 1;
  const close = closeBracket(body, open);
  if (close < 0 || target === '' || /\s(and|or|in|is|if)\s/.test(target)) return undefined;
  const args = body.slice(open + 1, close).trim();
  const rest = body.slice(close + 1).trim();
  const not = negated ? 'not_' : '';

  if (STATE[method[1]]) {
    if (args !== '') return undefined;
    if (rest === '' || rest === '== True' || rest === 'is True') return `${prefix}expect(${target}).${not}${STATE[method[1]]}()`;
    if (rest === '== False' || rest === 'is False') return `${prefix}expect(${target}).${negated ? '' : 'not_'}${STATE[method[1]]}()`;
    return undefined;
  }
  if (negated) return undefined;
  const eq = /^==\s*(.+)$/.exec(rest);
  if (VALUE[method[1]] && args === '' && eq) return `${prefix}expect(${target}).${VALUE[method[1]]}(${eq[1].trim()})`;
  if (method[1] === 'get_attribute' && args !== '' && eq) return `${prefix}expect(${target}).to_have_attribute(${args}, ${eq[1].trim()})`;
  return undefined;
}

function selectorRisk(selector: string): boolean {
  const s = selector.trim();
  if (/^(xpath=|\/\/|\(\/\/|\.\.\/)/.test(s)) return true;
  if (/:nth-(child|of-type)\(/.test(s)) return true;
  if (/\.(css|sc|jsx|emotion)-[a-z0-9]{5,}/i.test(s) || /\.[A-Za-z]+_[A-Za-z]+__[A-Za-z0-9]{5}/.test(s)) return true;
  const steps = s.replace(/\[[^\]]*\]|\([^)]*\)|"[^"]*"|'[^']*'/g, '').split(/\s*>\s*|\s+/).filter(Boolean);
  return steps.length >= 4;
}

/** Scan one pytest module's source. `file` is only copied into the findings. */
export function scanPythonFlakeRisks(file: string, source: string): FlakeFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: FlakeFinding[] = [];
  const importsExpect = /^\s*from\s+playwright\.(sync_api|async_api)\s+import\s+[^\n]*\bexpect\b/m.test(source) || /^\s*from\s+playwright\.(sync_api|async_api)\s+import\s*\([^)]*\bexpect\b/ms.test(source);
  let currentTest: string | undefined;
  let asyncDef = false;
  let defIndent = -1;
  let docstring: string | undefined;

  const add = (index: number, rule: FlakeRule, fix?: string): void => {
    const lineText = lines[index];
    findings.push({
      file,
      line: index + 1,
      rule,
      severity: RULES[rule].severity,
      message: PY_MESSAGES[rule] ?? RULES[rule].message,
      code: lineText.trim(),
      ...(fix !== undefined && fix !== lineText ? { fix } : {}),
      ...(currentTest ? { test: currentTest } : {}),
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (docstring) {
      if (trimmed.includes(docstring)) docstring = undefined;
      continue;
    }
    const doc = /^[rRbBuU]?("""|''')/.exec(trimmed);
    if (doc) {
      if (trimmed.indexOf(doc[1], doc[0].length) < 0) docstring = doc[1];
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const code = raw.replace(/\s#(?=(?:[^'"]|'[^']*'|"[^"]*")*$).*$/, '');
    const indent = raw.length - raw.trimStart().length;

    const def = /^(async\s+)?def\s+(\w+)\s*\(/.exec(trimmed);
    if (def) {
      asyncDef = Boolean(def[1]);
      defIndent = indent;
      currentTest = def[2].startsWith('test') ? def[2] : undefined;
      continue;
    } else if (defIndent >= 0 && indent <= defIndent && !/^[)\]}]/.test(trimmed) && !trimmed.startsWith('@')) {
      asyncDef = false;
      currentTest = undefined;
      defIndent = -1;
    }

    if (/\.wait_for_timeout\(/.test(code)) add(i, 'hard-wait');
    if (/(^|[^\w.])(time\.)?sleep\(\s*[\d.]+\s*\)/.test(code) && /\bsleep\(/.test(code) && !/\.wait_for/.test(code)) add(i, 'sleep');

    if (ONE_SHOT.test(code) || URL_ASSERT.test(code)) {
      add(i, 'non-retrying-assertion', importsExpect ? pythonWebFirstRewrite(raw) : undefined);
    } else if (asyncDef && !/\bawait\b/.test(code) && !/^\s*(return|yield|lambda|with|async\s+with)\b/.test(code) && !/=\s*\w*\.?expect_/.test(code)) {
      if (/^(expect\(.*\)\.(not_)?to_\w+\(|page\.\w)/.test(trimmed) && (ACTIONS.test(code) || /^expect\(/.test(trimmed)) && !/^page\.(on|once|remove_listener|route|unroute|expect_\w+)\(/.test(trimmed)) {
        add(i, 'missing-await', raw.replace(/^(\s*)/, '$1await '));
      }
    }

    if (/\bforce\s*=\s*True\b/.test(code)) add(i, 'force-action');
    if (/['"]networkidle['"]/.test(code)) add(i, 'networkidle');
    if (/\.(query_selector|query_selector_all|wait_for_selector|eval_on_selector|eval_on_selector_all|element_handle|element_handles)\(/.test(code)) add(i, 'element-handle');
    for (const m of code.matchAll(/(?:\.locator|\.query_selector(?:_all)?|\.wait_for_selector)\(\s*[rf]?(['"])((?:\\.|(?!\1)[^\\])+)\1/g)) {
      if (selectorRisk(m[2])) {
        add(i, 'fragile-selector');
        break;
      }
    }
    if (/\btimeout\s*=\s*0\b/.test(code) || /set_default(_navigation)?_timeout\(\s*0\s*\)/.test(code)) add(i, 'no-timeout');
    if (/\.goto\(\s*f?['"]https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/'"]/.test(code)) add(i, 'hardcoded-url');
  }
  return findings;
}
