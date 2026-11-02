/**
 * Playwright locators in Python syntax (pytest-playwright), converted to and
 * from the TypeScript form the rest of the server works with:
 *
 *   get_by_role("button", name="Buy now", exact=True).first
 *   getByRole('button', { name: 'Buy now', exact: true }).first()
 *
 * Python error messages and call logs print locators this way, and a fix for
 * a `.py` spec has to be written back this way.
 */

import { LOCATOR_METHODS, parseLocator } from './locator-expr.js';

const METHODS = new Set<string>(LOCATOR_METHODS);
import type { LocatorArg, LocatorCall } from './locator-expr.js';

const snakeToCamel = (name: string): string => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const camelToSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Python methods that are properties (no call parentheses). */
const PROPERTIES = new Set(['first', 'last', 'content_frame']);
const START_RE = /\b(get_by_(?:role|text|label|placeholder|alt_text|title|test_id)|locator|frame_locator)\s*\(/g;

/** Index of the parenthesis closing the one at `open`, skipping strings; -1 if none. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a Python argument list at top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim() !== '') out.push(text.slice(start));
  return out.map((part) => part.trim());
}

/** The value of a Python string literal's body (`raw` for r"…"). */
function decodePyString(body: string, raw: boolean): string {
  if (raw) return body;
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
  return body.replace(/\\(.)/g, (all, ch: string) => simple[ch] ?? all);
}

/** A string as a single-quoted TypeScript literal. */
function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
}

/** One Python value as TypeScript source. */
function valueToTs(value: string): string {
  const v = value.trim();
  if (v === 'True') return 'true';
  if (v === 'False') return 'false';
  const re = /^re\.compile\(\s*r?(["'])((?:\\.|(?!\1)[^\\])*)\1\s*(?:,\s*re\.(IGNORECASE|I))?\s*\)$/.exec(v);
  // Regex source keeps its escapes; only a bare "/" needs one in a /…/ literal.
  if (re) return `/${re[2].replace(/\\.|\//g, (m) => (m === '/' ? '\\/' : m))}/${re[3] ? 'i' : ''}`;
  const str = /^(r?)(["'])((?:\\.|(?!\2)[^\\])*)\2$/.exec(v);
  if (str) return tsString(decodePyString(str[3], str[1] === 'r'));
  return v;
}

/**
 * The Python locator chain that starts at `start` in `text`: its end index
 * and its TypeScript form. Returns undefined when it is not a clean chain.
 */
export function readPythonChain(text: string, start: number): { end: number; ts: string } | undefined {
  let i = start;
  const parts: string[] = [];
  for (let n = 0; n < 8; n += 1) {
    const call = /^\s*\.?\s*([a-z_]+)/.exec(text.slice(i));
    if (!call || (n > 0 && !/^\s*\./.test(text.slice(i)))) break;
    const name = call[1];
    // Stop at the action or assertion that follows the locator (.click(), .fill()).
    if (!METHODS.has(snakeToCamel(name))) break;
    const after = i + call[0].length;
    if (PROPERTIES.has(name) && !/^\s*\(/.test(text.slice(after))) {
      parts.push(`${snakeToCamel(name)}()`);
      i = after;
      continue;
    }
    const open = text.indexOf('(', after);
    if (open < 0 || text.slice(after, open).trim() !== '') break;
    const close = closeParen(text, open);
    if (close < 0) return undefined;
    const args = splitArgs(text.slice(open + 1, close));
    const positional: string[] = [];
    const options: string[] = [];
    for (const arg of args) {
      const kw = /^([a-z_]+)\s*=\s*([\s\S]+)$/.exec(arg);
      if (kw) options.push(`${snakeToCamel(kw[1])}: ${valueToTs(kw[2])}`);
      else positional.push(valueToTs(arg));
    }
    if (options.length > 0) positional.push(`{ ${options.join(', ')} }`);
    parts.push(`${snakeToCamel(name)}(${positional.join(', ')})`);
    i = close + 1;
  }
  if (parts.length === 0) return undefined;
  const ts = parts.join('.');
  try {
    parseLocator(ts);
  } catch {
    return undefined;
  }
  return { end: i, ts };
}

/** Rewrite every Python locator in a message (call log, strict-mode list) in TypeScript syntax. */
export function pythonMessageToTs(message: string): string {
  let out = '';
  let last = 0;
  for (const match of message.matchAll(START_RE)) {
    if (match.index! < last) continue;
    const chain = readPythonChain(message, match.index!);
    if (!chain) continue;
    out += message.slice(last, match.index!) + chain.ts;
    last = chain.end;
  }
  return out + message.slice(last);
}

function argToPy(arg: LocatorArg): string {
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (typeof arg === 'boolean') return arg ? 'True' : 'False';
  if (typeof arg === 'number') return String(arg);
  if ('$regex' in arg && typeof arg.$regex === 'string') {
    return `re.compile(r${JSON.stringify(arg.$regex)}${String(arg.flags ?? '').includes('i') ? ', re.IGNORECASE' : ''})`;
  }
  return Object.entries(arg)
    .map(([key, value]) => `${camelToSnake(key)}=${argToPy(value)}`)
    .join(', ');
}

/** A locator chain in Python syntax, e.g. `get_by_role("button", name="Save")`. */
export function formatPythonLocator(calls: LocatorCall[]): string {
  return calls
    .map((call) => {
      const name = camelToSnake(call.method);
      if (PROPERTIES.has(name) && call.args.length === 0) return name;
      return `${name}(${call.args.map(argToPy).join(', ')})`;
    })
    .join('.');
}

/**
 * Where the Python form of `chain` (its first `calls` calls) sits on a source
 * line, matched by the first call's name and first string argument.
 */
export function findPythonChainSpan(line: string, chain: LocatorCall[], calls = chain.length): { start: number; end: number } | undefined {
  const first = chain[0];
  const arg = first.args[0];
  if (typeof arg !== 'string') return undefined;
  const name = camelToSnake(first.method);
  for (const match of line.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const read = readPythonChain(line, match.index!);
    if (!read) continue;
    let parsed: LocatorCall[];
    try {
      parsed = parseLocator(read.ts);
    } catch {
      continue;
    }
    if (parsed[0].args[0] !== arg) continue;
    if (parsed.length < calls) continue;
    // Walk the first `calls` pieces for the span end.
    let end = match.index!;
    for (let taken = 0; taken < calls; taken += 1) {
      const piece = /^\s*\.?\s*([a-z_]+)/.exec(line.slice(end));
      if (!piece) break;
      const after = end + piece[0].length;
      if (PROPERTIES.has(piece[1]) && !/^\s*\(/.test(line.slice(after))) end = after;
      else end = closeParen(line, line.indexOf('(', after)) + 1;
    }
    return { start: match.index!, end };
  }
  return undefined;
}
