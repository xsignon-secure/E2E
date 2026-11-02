/**
 * Mock drift: find the network mocks in test files (route.fulfill bodies in
 * TypeScript/JavaScript and pytest-playwright specs, and routeFromHAR
 * files), and compare the JSON shape each one returns with what the live
 * endpoint returns now. A mock that still sends `price` as a number after
 * the API switched to a string keeps the test green while production breaks.
 *
 * The parsing is deliberately small: object, array, string, number and
 * boolean literals are read; anything computed is marked unknown and left
 * out of the comparison, so a finding is always about a field the mock
 * really states.
 */

/* ------------------------------------------------------------------ */
/* Literal parsing                                                     */
/* ------------------------------------------------------------------ */

/** A value whose type cannot be read from the source (a variable, a call…). */
export const UNKNOWN = Symbol('unknown');

export type Literal = string | number | boolean | null | typeof UNKNOWN | Literal[] | { [key: string]: Literal } | PartialObject;

/** An object literal with a spread or a computed key: the listed keys are known, others may exist. */
export interface PartialObject {
  [key: string]: Literal;
}

const PARTIAL = Symbol('partial');

function isPartial(value: object): boolean {
  return (value as Record<symbol, unknown>)[PARTIAL] === true;
}

class LiteralParser {
  private i: number;
  constructor(
    private readonly src: string,
    start: number,
  ) {
    this.i = start;
  }

  get pos(): number {
    return this.i;
  }

  private skip(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i += 1;
      if (this.src.startsWith('//', this.i) || (this.src[this.i] === '#' && !this.src.startsWith('#{', this.i))) {
        const end = this.src.indexOf('\n', this.i);
        this.i = end < 0 ? this.src.length : end + 1;
        continue;
      }
      if (this.src.startsWith('/*', this.i)) {
        const end = this.src.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.src.length : end + 2;
        continue;
      }
      return;
    }
  }

  /** Skip an expression we cannot read, up to the next top-level `,` or closing bracket. */
  private skipExpression(): void {
    const stack: string[] = [];
    let quote = '';
    for (; this.i < this.src.length; this.i += 1) {
      const ch = this.src[this.i];
      if (quote) {
        if (ch === '\\') this.i += 1;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (stack.length === 0) return;
        stack.pop();
      } else if (ch === ',' && stack.length === 0) return;
    }
  }

  value(): Literal {
    this.skip();
    const ch = this.src[this.i];
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"' || ch === "'" || ch === '`') {
      const text = this.string();
      return this.afterAtom(text);
    }
    const num = /^-?(?:\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(this.src.slice(this.i, this.i + 40));
    if (num) {
      this.i += num[0].length;
      return this.afterAtom(Number(num[0].replace(/_/g, '')));
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i, this.i + 40));
    if (word) {
      const known: Record<string, Literal> = { true: true, false: false, True: true, False: false, null: null, None: null };
      if (word[0] in known) {
        this.i += word[0].length;
        return this.afterAtom(known[word[0]]);
      }
    }
    this.skipExpression();
    return UNKNOWN;
  }

  /** A literal followed by an operator (`'a' + b`, `1 * x`) is computed: unknown. */
  private afterAtom(value: Literal): Literal {
    const save = this.i;
    this.skip();
    const next = this.src[this.i];
    if (next === undefined || next === ',' || next === '}' || next === ']' || next === ')' || next === ':' ) {
      this.i = save;
      return value;
    }
    if (typeof value === 'string' && (next === '+' || next === '.')) {
      this.skipExpression();
      return 'string';
    }
    this.skipExpression();
    return UNKNOWN;
  }

  private string(): string {
    const quote = this.src[this.i];
    this.i += 1;
    let out = '';
    for (; this.i < this.src.length; this.i += 1) {
      const ch = this.src[this.i];
      if (ch === '\\') {
        out += this.src[this.i + 1] ?? '';
        this.i += 1;
        continue;
      }
      if (ch === quote) {
        this.i += 1;
        return out;
      }
      if (quote === '`' && ch === '$' && this.src[this.i + 1] === '{') {
        // Interpolated: still a string, content unknown.
        let depth = 0;
        for (; this.i < this.src.length; this.i += 1) {
          if (this.src[this.i] === '{') depth += 1;
          else if (this.src[this.i] === '}') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        continue;
      }
      out += ch;
    }
    return out;
  }

  private object(): Literal {
    this.i += 1;
    const out: Record<string, Literal> = {};
    for (;;) {
      this.skip();
      const ch = this.src[this.i];
      if (ch === undefined) return UNKNOWN;
      if (ch === '}') {
        this.i += 1;
        return out;
      }
      if (ch === ',') {
        this.i += 1;
        continue;
      }
      if (this.src.startsWith('...', this.i) || this.src.startsWith('**', this.i)) {
        this.i += this.src.startsWith('...', this.i) ? 3 : 2;
        this.skipExpression();
        Object.defineProperty(out, PARTIAL, { value: true, enumerable: false });
        continue;
      }
      let key: string | undefined;
      if (ch === '"' || ch === "'" || ch === '`') key = this.string();
      else {
        const word = /^[A-Za-z_$][\w$]*|^\d+/.exec(this.src.slice(this.i, this.i + 200));
        if (word) {
          key = word[0];
          this.i += word[0].length;
        }
      }
      this.skip();
      if (key === undefined || this.src[this.i] !== ':') {
        // A computed key, a method or a shorthand property: unknown.
        if (key !== undefined && (this.src[this.i] === ',' || this.src[this.i] === '}')) {
          out[key] = UNKNOWN;
          continue;
        }
        this.skipExpression();
        Object.defineProperty(out, PARTIAL, { value: true, enumerable: false });
        continue;
      }
      this.i += 1;
      out[key] = this.value();
    }
  }

  private array(): Literal {
    this.i += 1;
    const out: Literal[] = [];
    for (;;) {
      this.skip();
      const ch = this.src[this.i];
      if (ch === undefined) return UNKNOWN;
      if (ch === ']') {
        this.i += 1;
        return out;
      }
      if (ch === ',') {
        this.i += 1;
        continue;
      }
      if (this.src.startsWith('...', this.i)) {
        this.i += 3;
        this.skipExpression();
        continue;
      }
      out.push(this.value());
    }
  }
}

/** Parse the JS/Python literal that starts at `start` (an object, array, string, number…). */
export function parseLiteral(src: string, start = 0): Literal {
  return new LiteralParser(src, start).value();
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type Shape =
  | { type: 'object'; keys: Record<string, Shape>; partial?: boolean }
  | { type: 'array'; item?: Shape }
  | { type: 'string' | 'number' | 'boolean' | 'null' | 'unknown' };

export function shapeOf(value: unknown): Shape {
  if (value === UNKNOWN || value === undefined) return { type: 'unknown' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    let item: Shape | undefined;
    for (const entry of value.slice(0, 20)) item = item ? mergeShapes(item, shapeOf(entry)) : shapeOf(entry);
    return item ? { type: 'array', item } : { type: 'array' };
  }
  if (typeof value === 'object') {
    const keys: Record<string, Shape> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) keys[key] = shapeOf(entry);
    return isPartial(value as object) ? { type: 'object', keys, partial: true } : { type: 'object', keys };
  }
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'unknown' };
}

/** Combine the shapes of two array items: keys from either, the first concrete type wins. */
function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === 'unknown' || a.type === 'null') return b.type === 'unknown' ? a : b;
  if (b.type === 'unknown' || b.type === 'null') return a;
  if (a.type === 'object' && b.type === 'object') {
    const keys: Record<string, Shape> = { ...a.keys };
    for (const [key, shape] of Object.entries(b.keys)) keys[key] = keys[key] ? mergeShapes(keys[key], shape) : shape;
    return { type: 'object', keys, ...(a.partial || b.partial ? { partial: true } : {}) };
  }
  if (a.type === 'array' && b.type === 'array') {
    if (!a.item) return b;
    if (!b.item) return a;
    return { type: 'array', item: mergeShapes(a.item, b.item) };
  }
  return a;
}

export type DriftRule = 'missing-field' | 'type-changed' | 'now-null' | 'new-field' | 'endpoint-gone' | 'not-json' | 'server-error' | 'status-changed';

export interface DriftFinding {
  rule: DriftRule;
  severity: 'high' | 'medium' | 'low';
  /** JSON path, e.g. `items[].price`; empty for the whole body. */
  path: string;
  message: string;
}

function label(path: string): string {
  return path === '' ? 'the body' : `\`${path}\``;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an **${type}**` : `a **${type}**`;
}

/** Compare what the mock returns with what the live endpoint returns. */
export function diffShapes(mock: Shape, live: Shape, path = ''): DriftFinding[] {
  if (mock.type === 'unknown' || mock.type === 'null' || live.type === 'unknown') return [];
  if (live.type === 'null') {
    return [{ rule: 'now-null', severity: 'medium', path, message: `${label(path)} is ${article(mock.type)} in the mock but **null** in the live response: the app must handle null here.` }];
  }
  if (mock.type !== live.type) {
    return [{ rule: 'type-changed', severity: 'high', path, message: `${label(path)} is ${article(mock.type)} in the mock but ${article(live.type)} in the live response.` }];
  }
  const findings: DriftFinding[] = [];
  if (mock.type === 'object' && live.type === 'object') {
    for (const [key, shape] of Object.entries(mock.keys)) {
      const child = path ? `${path}.${key}` : key;
      if (!(key in live.keys)) {
        findings.push({ rule: 'missing-field', severity: 'high', path: child, message: `${label(child)} is in the mock but the live response no longer has it.` });
        continue;
      }
      findings.push(...diffShapes(shape, live.keys[key], child));
    }
    const extra = Object.keys(live.keys).filter((key) => !(key in mock.keys));
    if (extra.length > 0 && !mock.partial) {
      const shown = extra.slice(0, 6).map((key) => `\`${key}\``).join(', ');
      findings.push({
        rule: 'new-field',
        severity: 'low',
        path,
        message: `The live ${path ? label(path) : 'response'} has ${extra.length} field(s) the mock lacks: ${shown}${extra.length > 6 ? '…' : ''}.`,
      });
    }
  }
  if (mock.type === 'array' && live.type === 'array' && mock.item && live.item) {
    findings.push(...diffShapes(mock.item, live.item, `${path}[]`));
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Finding mocks in test files                                         */
/* ------------------------------------------------------------------ */

export interface FoundMock {
  file: string;
  line: number;
  /** The route pattern as written: a glob/URL, or `/regex/` for a regex. */
  pattern: string;
  regex?: boolean;
  /** HTTP method the handler limits itself to, when it checks one. */
  method?: string;
  /** Status the mock answers with (default 200). */
  status: number;
  /** The mocked JSON body; undefined when it is not JSON or not readable. */
  body?: Literal;
  /** Where the body comes from, when it is a file (route.fulfill path or a HAR). */
  bodyFile?: string;
  /** Recorded in a HAR file rather than written in the test. */
  har?: string;
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

/** Index of the bracket closing the one at `open` (quotes skipped); -1 when unbalanced. */
function closing(src: string, open: number): number {
  const stack: string[] = [];
  let quote = '';
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The body of a named handler defined in the same file (function, arrow or Python def). */
function handlerBody(src: string, name: string, python: boolean): string | undefined {
  if (python) {
    const def = new RegExp(`^([ \\t]*)(?:async\\s+)?def\\s+${name}\\s*\\(`, 'm').exec(src);
    if (!def) return undefined;
    const indent = def[1].length;
    const rest = src.slice(def.index).split('\n');
    const body = [rest[0]];
    for (const line of rest.slice(1)) {
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    return body.join('\n');
  }
  const def = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).exec(src);
  if (!def) return undefined;
  const brace = src.indexOf('{', def.index);
  if (brace < 0) return undefined;
  const end = closing(src, brace);
  return end < 0 ? undefined : src.slice(def.index, end + 1);
}

/**
 * A JSON body written as a string literal: Python `body='{"id": 1}'` (also
 * triple-quoted and r-strings) or JS `body: '{"id": 1}'` / a template literal
 * without substitutions. Undefined when it is not a literal or not JSON.
 */
export function jsonFromStringLiteral(src: string, start: number): Literal | undefined {
  let i = start;
  let raw = false;
  while (i < src.length && /[rRbBuU]/.test(src[i])) {
    if (/[rR]/.test(src[i])) raw = true;
    i += 1;
  }
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  const triple = quote !== '`' && src.startsWith(quote.repeat(3), i);
  const close = triple ? quote.repeat(3) : quote;
  i += close.length;
  let text = '';
  while (i < src.length) {
    if (src.startsWith(close, i)) {
      try {
        return JSON.parse(text) as Literal;
      } catch {
        return undefined;
      }
    }
    const ch = src[i];
    if (quote === '`' && ch === '$' && src[i + 1] === '{') return undefined;
    if (!triple && quote !== '`' && ch === '\n') return undefined;
    if (ch === '\\' && !raw) {
      const next = src[i + 1];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '`': '`' };
      text += map[next] ?? `\\${next}`;
      i += 2;
      continue;
    }
    text += ch;
    i += 1;
  }
  return undefined;
}

/** Read status, method and body from the handler of one route. */
function readHandler(handler: string, python: boolean): Pick<FoundMock, 'status' | 'body' | 'bodyFile' | 'method'> | undefined {
  const fulfill = /\.fulfill\s*\(/.exec(handler);
  if (!fulfill) return undefined;
  const open = fulfill.index + fulfill[0].length - 1;
  const end = closing(handler, open);
  const args = handler.slice(open + 1, end < 0 ? undefined : end);
  const out: Pick<FoundMock, 'status' | 'body' | 'bodyFile' | 'method'> = { status: 200 };
  const sep = python ? '=' : ':';
  const status = new RegExp(`\\bstatus\\s*${sep}\\s*(\\d{3})`).exec(args);
  if (status) out.status = Number(status[1]);
  const json = new RegExp(`\\bjson\\s*${sep}\\s*`).exec(args);
  const stringified = python ? /\bbody\s*=\s*json\.dumps\s*\(/.exec(args) : /\bbody\s*:\s*JSON\.stringify\s*\(/.exec(args);
  const file = new RegExp(`\\bpath\\s*${sep}\\s*(['"])([^'"]+\\.json)\\1`).exec(args);
  const rawBody = new RegExp(`\\bbody\\s*${sep}\\s*(?=[rRbBuU]?['"\`])`).exec(args);
  if (json) out.body = parseLiteral(args, json.index + json[0].length);
  else if (stringified) out.body = parseLiteral(args, stringified.index + stringified[0].length);
  else if (rawBody) out.body = jsonFromStringLiteral(args, rawBody.index + rawBody[0].length);
  else if (file) out.bodyFile = file[2];
  const method = /\.method(?:\(\))?\s*(===|==)\s*(['"])([A-Za-z]+)\2/.exec(handler) ?? /(['"])([A-Za-z]+)\1\s*(===|==)\s*[\w.]*\.method/.exec(handler);
  if (method) out.method = (method[3] && /^[A-Za-z]+$/.test(method[3]) ? method[3] : method[2]).toUpperCase();
  return out;
}

/** Find route.fulfill mocks and routeFromHAR files in one test file. */
export function findMocks(file: string, src: string): FoundMock[] {
  const python = file.endsWith('.py');
  const mocks: FoundMock[] = [];
  for (const match of src.matchAll(/\.route\s*\(\s*/g)) {
    const start = match.index + match[0].length;
    const open = match.index + match[0].indexOf('(');
    const end = closing(src, open);
    if (end < 0) continue;
    const call = src.slice(start, end);
    let pattern: string | undefined;
    let regex = false;
    let afterPattern = 0;
    const str = /^(?:r|f)?(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(call);
    const re = /^\/((?:\\.|[^/\n\\])+)\/[a-z]*/.exec(call);
    const pyRe = /^re\.compile\(\s*r?(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(call);
    if (str) {
      pattern = str[2];
      afterPattern = str[0].length;
    } else if (re) {
      pattern = `/${re[1]}/`;
      regex = true;
      afterPattern = re[0].length;
    } else if (pyRe) {
      pattern = `/${pyRe[2]}/`;
      regex = true;
      afterPattern = pyRe[0].length;
    } else continue;
    let handler = call.slice(afterPattern);
    const named = /^\s*,\s*([A-Za-z_$][\w$]*)\s*(?:[,)]|$)/.exec(handler);
    if (named) handler = handlerBody(src, named[1], python) ?? '';
    const read = readHandler(handler, python);
    if (!read) continue;
    mocks.push({ file, line: lineAt(src, match.index), pattern, ...(regex ? { regex } : {}), ...read });
  }
  for (const match of src.matchAll(/\.(?:routeFromHAR|route_from_har)\s*\(\s*(?:r?)(['"`])([^'"`]+)\1/g)) {
    mocks.push({ file, line: lineAt(src, match.index), pattern: match[2], status: 200, har: match[2] });
  }
  return mocks;
}

/** GET entries with a JSON response from a HAR file, one per URL. */
export function mocksFromHar(file: string, line: number, harPath: string, harText: string): FoundMock[] {
  let har: { log?: { entries?: Array<{ request?: { method?: string; url?: string }; response?: { status?: number; content?: { mimeType?: string; text?: string; encoding?: string } } }> } };
  try {
    har = JSON.parse(harText) as typeof har;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: FoundMock[] = [];
  for (const entry of har.log?.entries ?? []) {
    const url = entry.request?.url;
    const method = (entry.request?.method ?? 'GET').toUpperCase();
    const content = entry.response?.content;
    if (!url || method !== 'GET' || !content?.mimeType?.includes('json') || content.text === undefined) continue;
    if (seen.has(url) || out.length >= 20) continue;
    seen.add(url);
    let body: Literal | undefined;
    try {
      const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
      body = JSON.parse(text) as Literal;
    } catch {
      continue;
    }
    out.push({ file, line, pattern: url, status: entry.response?.status ?? 200, body, har: harPath, method: 'GET' });
  }
  return out;
}

/**
 * The concrete URL to call for a mock pattern: an absolute URL as is, a
 * path or `**​/path` glob against baseUrl. Patterns with other wildcards and
 * regexes need an entry in `urls`. Returns a reason instead when it cannot.
 */
export function liveUrl(mock: Pick<FoundMock, 'pattern' | 'regex'>, baseUrl: string | undefined, urls: Record<string, string> = {}): { url: string } | { reason: string } {
  const mapped = urls[mock.pattern];
  const resolve = (target: string): { url: string } | { reason: string } => {
    if (/^https?:\/\//i.test(target)) return { url: target };
    if (!baseUrl) return { reason: 'relative pattern and no baseUrl (pass baseUrl, or set use.baseURL in the Playwright config)' };
    return { url: new URL(target.replace(/^\/*/, '/'), baseUrl).toString() };
  };
  if (mapped) return resolve(mapped);
  if (mock.regex) return { reason: `regex pattern; map it to a real URL with urls: { "${mock.pattern}": "/api/…" }` };
  let pattern = mock.pattern;
  if (pattern.startsWith('**/')) pattern = pattern.slice(2);
  else if (pattern.startsWith('*/')) pattern = pattern.slice(1);
  if (/[*{}[\]]/.test(pattern)) return { reason: `wildcard pattern; map it to a real URL with urls: { "${mock.pattern}": "/api/…" }` };
  return resolve(pattern);
}
