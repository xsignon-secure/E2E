/**
 * A tiny Playwright reporter that writes one JSON line per test attempt.
 *
 * Playwright's JSON reporter keeps a single result per test, so with
 * --repeat-each the repeats disappear from it. diagnose-flaky needs every
 * attempt (which repeat, which worker, pass or fail, how long), so runs
 * started with `collectAttempts` add this reporter next to the JSON one.
 *
 * The reporter runs inside the project's own Playwright process, so it is
 * plain CommonJS with no imports beyond `fs`, written once per server
 * process to the temp directory.
 */

import { writeFile } from 'node:fs/promises';
import type { TestAttempt } from '../types/index.js';
import { isAbsolutePath, isPathInside, normalizePath, relativeToRoot, resolvePath, tempFilePath } from './path-utils.js';
import { mapStatus, stripAnsi } from './report-parser.js';

/** Environment variable naming the JSONL file the reporter appends to. */
export const ATTEMPTS_FILE_ENV = 'PW_MCP_ATTEMPTS_FILE';

const REPORTER_SOURCE = `'use strict';
const fs = require('fs');
class PlaywrightE2eMcpAttempts {
  constructor() { this.file = process.env.${ATTEMPTS_FILE_ENV}; this.asserts = new WeakMap(); }
  printsToStdio() { return false; }
  onStepEnd(test, result, step) {
    // Assertions that actually ran (expect, expect.soft, expect.poll), so a
    // fix that skips them at run time is visible even when the code looks fine.
    if (step && step.category === 'expect') this.asserts.set(result, (this.asserts.get(result) || 0) + 1);
  }
  onTestEnd(test, result) {
    if (!this.file) return;
    let project;
    try { project = test.parent.project() && test.parent.project().name; } catch (e) { project = undefined; }
    const err = result.error || (result.errors && result.errors[0]);
    const line = {
      file: test.location && test.location.file,
      line: test.location && test.location.line,
      title: test.titlePath().slice(3).join(' \\u203a '),
      project: project,
      repeatEachIndex: test.repeatEachIndex || 0,
      retry: result.retry || 0,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
      workerIndex: result.workerIndex,
      assertions: this.asserts.get(result) || 0,
      message: err && err.message ? String(err.message).split('\\n')[0].slice(0, 300) : undefined,
    };
    try { fs.appendFileSync(this.file, JSON.stringify(line) + '\\n'); } catch (e) { /* best effort */ }
  }
}
module.exports = PlaywrightE2eMcpAttempts;
`;

let reporterPath: Promise<string> | undefined;

/** Absolute path of the reporter module, written on first use. */
export function attemptsReporterPath(): Promise<string> {
  if (!reporterPath) {
    const target = tempFilePath('pw-mcp-attempts-reporter', '.cjs');
    reporterPath = writeFile(target, REPORTER_SOURCE, 'utf8').then(
      () => target,
      (err: unknown) => {
        reporterPath = undefined;
        throw err;
      },
    );
  }
  return reporterPath;
}

/** Parse the reporter's JSONL output; malformed lines are skipped. */
export function parseAttempts(raw: string, root: string): TestAttempt[] {
  const attempts: TestAttempt[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.title !== 'string') continue;
    let file = typeof entry.file === 'string' ? normalizePath(entry.file) : '';
    if (file !== '') {
      const absolute = isAbsolutePath(file) ? file : resolvePath(root, file);
      if (isPathInside(absolute, root)) file = relativeToRoot(root, absolute);
    }
    const message = typeof entry.message === 'string' ? stripAnsi(entry.message).trim() : '';
    attempts.push({
      file,
      line: typeof entry.line === 'number' ? entry.line : undefined,
      title: entry.title,
      project: typeof entry.project === 'string' && entry.project !== '' ? entry.project : undefined,
      repeatEachIndex: typeof entry.repeatEachIndex === 'number' ? entry.repeatEachIndex : 0,
      retry: typeof entry.retry === 'number' ? entry.retry : 0,
      status: mapStatus(typeof entry.status === 'string' ? entry.status : undefined),
      expectedStatus: typeof entry.expectedStatus === 'string' ? entry.expectedStatus : undefined,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
      workerIndex: typeof entry.workerIndex === 'number' ? entry.workerIndex : undefined,
      ...(typeof entry.assertions === 'number' ? { assertions: entry.assertions } : {}),
      message: message === '' ? undefined : message,
    });
  }
  return attempts;
}
