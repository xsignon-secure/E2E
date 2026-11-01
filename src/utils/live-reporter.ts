/**
 * A Playwright reporter that writes each test result to a JSONL file the
 * moment the test ends.
 *
 * Playwright's JSON reporter writes its report once, when the whole run
 * finishes. A run that is killed (our wall-clock limit, a crashed worker,
 * a client that went away) never gets there, and every failure that had
 * already happened was lost with it. This reporter runs next to the JSON
 * one on every run-test call; when the JSON report is missing, its lines
 * are turned back into a JSON-reporter-shaped report, so the failures that
 * finished keep their message, code frame, location and trace.
 *
 * Titles keep the file suite (titlePath from index 2), as the JSON reporter
 * does, so a recovered failure has the same title as a normal one.
 *
 * Like the attempts reporter it runs inside the project's own Playwright
 * process, so it is plain CommonJS that only needs `fs`.
 */

import { writeFile } from 'node:fs/promises';
import { tempFilePath } from './path-utils.js';

/** Environment variable naming the JSONL file the reporter appends to. */
export const LIVE_RESULTS_FILE_ENV = 'PW_MCP_LIVE_RESULTS_FILE';

/** Longest error message / stack / snippet kept per result. */
const MAX_TEXT = 8_000;

const REPORTER_SOURCE = `'use strict';
const fs = require('fs');
const clip = (text) => (typeof text === 'string' ? text.slice(0, ${MAX_TEXT}) : undefined);
class PlaywrightE2eMcpLiveResults {
  constructor() { this.file = process.env.${LIVE_RESULTS_FILE_ENV}; }
  printsToStdio() { return false; }
  onTestEnd(test, result) {
    if (!this.file) return;
    let project;
    try { project = test.parent.project() && test.parent.project().name; } catch (e) { project = undefined; }
    const failed = result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted';
    const errors = failed
      ? (result.errors && result.errors.length ? result.errors : result.error ? [result.error] : []).slice(0, 3).map((e) => ({
          message: clip(e.message || e.value),
          stack: clip(e.stack),
          codeframe: clip(e.snippet),
          location: e.location,
        }))
      : [];
    const line = {
      file: test.location && test.location.file,
      line: test.location && test.location.line,
      titlePath: test.titlePath().slice(2),
      project: project,
      status: result.status,
      retry: result.retry || 0,
      duration: result.duration,
      errors: errors,
      attachments: failed ? (result.attachments || []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path, contentType: a.contentType })) : [],
    };
    try { fs.appendFileSync(this.file, JSON.stringify(line) + '\\n'); } catch (e) { /* best effort */ }
  }
}
module.exports = PlaywrightE2eMcpLiveResults;
`;

let reporterPath: Promise<string> | undefined;

/** Absolute path of the reporter module, written on first use. */
export function liveReporterPath(): Promise<string> {
  if (!reporterPath) {
    const target = tempFilePath('pw-mcp-live-reporter', '.cjs');
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

interface LiveLine {
  file?: string;
  line?: number;
  titlePath: string[];
  project?: string;
  status: string;
  retry: number;
  duration?: number;
  errors: Array<{ message?: string; stack?: string; codeframe?: string; location?: { file?: string; line?: number; column?: number } }>;
  attachments: Array<{ name?: string; path?: string; contentType?: string }>;
}

function asLine(value: unknown): LiveLine | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.titlePath) || !entry.titlePath.every((t) => typeof t === 'string')) return null;
  if (typeof entry.status !== 'string') return null;
  return {
    file: typeof entry.file === 'string' ? entry.file : undefined,
    line: typeof entry.line === 'number' ? entry.line : undefined,
    titlePath: entry.titlePath as string[],
    project: typeof entry.project === 'string' && entry.project !== '' ? entry.project : undefined,
    status: entry.status,
    retry: typeof entry.retry === 'number' ? entry.retry : 0,
    duration: typeof entry.duration === 'number' ? entry.duration : undefined,
    errors: Array.isArray(entry.errors) ? (entry.errors as LiveLine['errors']) : [],
    attachments: Array.isArray(entry.attachments) ? (entry.attachments as LiveLine['attachments']) : [],
  };
}

/**
 * Turn the reporter's JSONL into a report shaped like Playwright's JSON
 * reporter output (suites → specs → tests → results), so the normal report
 * parser handles it. Returns undefined when no test had finished.
 * Malformed lines (a write cut off by the kill) are skipped.
 */
export function liveResultsToReport(raw: string): Record<string, unknown> | undefined {
  const groups = new Map<string, { line: LiveLine; results: LiveLine[] }>();
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const line = asLine(parsed);
    if (!line) continue;
    const key = JSON.stringify([line.file, line.line, line.titlePath, line.project]);
    const group = groups.get(key);
    if (group) group.results.push(line);
    else groups.set(key, { line, results: [line] });
  }
  if (groups.size === 0) return undefined;
  const specs = [...groups.values()].map(({ line, results }) => ({
    title: line.titlePath.join(' › '),
    file: line.file,
    line: line.line,
    tests: [
      {
        projectName: line.project ?? '',
        results: results
          .sort((a, b) => a.retry - b.retry)
          .map((r) => ({
            // "interrupted" is how Playwright marks a test the kill cut short.
            status: r.status === 'interrupted' ? 'failed' : r.status,
            retry: r.retry,
            duration: r.duration,
            error: r.errors[0],
            errors: r.errors,
            attachments: r.attachments,
          })),
      },
    ],
  }));
  return { config: {}, suites: [{ title: '', specs }] };
}
