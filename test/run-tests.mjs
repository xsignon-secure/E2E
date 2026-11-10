/**
 * Cross-platform test launcher.
 *
 * `node --test` discovery differs across Node versions: Node 20 does not
 * expand glob patterns, Node 24 no longer accepts directory arguments,
 * and default cwd discovery would also pick up `dist/*-test.js`. This
 * launcher enumerates `*.test.mjs` itself and passes explicit file
 * paths, which works on every Node version and shell (cmd, sh, pwsh).
 *
 * `--coverage` adds Node's built-in coverage report for the compiled
 * sources in dist/ (code run in child processes is not counted), and fails
 * the run when coverage drops below the floor in COVERAGE_FLOOR. The floor
 * sits a few points under what main measures (2026-11-10: 50.5-53.6%
 * lines, which moves between identical runs, 78% branches, 62% functions);
 * raise it as tests are added, never lower it to get a change through.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error('run-tests: no *.test.mjs files found');
  process.exit(1);
}

const COVERAGE_FLOOR = { lines: 45, branches: 72, functions: 60 };

const coverage = process.argv.includes('--coverage')
  ? [
      '--experimental-test-coverage',
      '--test-coverage-exclude=test/**',
      '--test-coverage-exclude=node_modules/**',
      '--test-coverage-exclude=e2e/**',
      `--test-coverage-lines=${COVERAGE_FLOOR.lines}`,
      `--test-coverage-branches=${COVERAGE_FLOOR.branches}`,
      `--test-coverage-functions=${COVERAGE_FLOOR.functions}`,
    ]
  : [];
const result = spawnSync(process.execPath, ['--test', ...coverage, ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
