/**
 * Cross-platform test launcher.
 *
 * `node --test` discovery differs across Node versions: Node 20 does not
 * expand glob patterns, Node 24 no longer accepts directory arguments,
 * and default cwd discovery would also pick up `dist/*-test.js`. This
 * launcher enumerates `*.test.mjs` itself and passes explicit file
 * paths, which works on every Node version and shell (cmd, sh, pwsh).
 *
 * Coverage is `npm run coverage`, which runs this launcher under c8 (see
 * .c8rc.json). c8 collects V8 coverage from every Node process the tests
 * start, including the MCP servers they spawn over stdio, maps it back to
 * src/ through the source maps, counts files no test loads as 0%, and fails
 * below the floor there. The floor sits about five points under what main
 * measures (2026-11-10: 65% lines, 78% branches, 52% functions); raise it
 * as tests are added, never lower it to get a change through.
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

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
