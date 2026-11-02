import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCiArgs } from '../dist/cli/ci.js';
import { resolveToolSelection, TOOL_PROFILES } from '../dist/server.js';

test('parseCiArgs reads flags and positional test paths', () => {
  const options = parseCiArgs(['--browser', 'firefox', '--workers', '2', '--flaky-runs', '4', '--suggest', '1', '--no-retry', 'tests/a.spec.ts']);
  assert.equal(options.browser, 'firefox');
  assert.equal(options.workers, 2);
  assert.equal(options.flakyRuns, 4);
  assert.equal(options.suggest, 1);
  assert.equal(options.retry, false);
  assert.equal(options.timeoutMs, 600_000);
  assert.deepEqual(options.testFiles, ['tests/a.spec.ts']);
});

test('parseCiArgs defaults and rejects bad values', () => {
  const options = parseCiArgs([]);
  assert.equal(options.retry, true);
  assert.equal(options.suggest, 0);
  assert.equal(options.flakyRuns, undefined);
  assert.throws(() => parseCiArgs(['--browser', 'edge']), /--browser/);
  assert.throws(() => parseCiArgs(['--flaky-runs', '1']), /--flaky-runs/);
  assert.throws(() => parseCiArgs(['--suggest', '9']), /--suggest/);
  assert.throws(() => parseCiArgs(['--unknown']), /Unknown option/);
});

test('resolveToolSelection expands profiles, keeps registry order and reports unknowns', () => {
  assert.deepEqual(resolveToolSelection(''), { unknown: [] });
  const core = resolveToolSelection('core');
  assert.deepEqual(new Set(core.tools), new Set(TOOL_PROFILES.core));
  const mixed = resolveToolSelection('inspect, run-test ,nope');
  assert.deepEqual(mixed.tools, ['run-test', 'inspect-page', 'validate-selector', 'audit-accessibility', 'audit-performance', 'compare-visual-state', 'save-login']);
  assert.deepEqual(mixed.unknown, ['nope']);
  assert.equal(resolveToolSelection('ALL').tools.length, 20);
  assert.equal(resolveToolSelection('nope').tools, undefined);
});

test('action.yml fits GitHub Marketplace limits and defaults to the package version', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const description = yml.match(/^description: (.*)$/m)?.[1] ?? '';
  assert.ok(description.length > 0 && description.length < 125, `description is ${description.length} chars`);
  assert.match(yml, /^branding:\n  icon: \S+\n  color: \S+/m);
  assert.ok(yml.split('\n').some((line) => line.trim() === `default: ${pkg.version}`), 'action default version');
});
