import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLatestTag, parseStable } from '../scripts/is-latest-tag.mjs';

test('the newest stable tag takes latest', () => {
  assert.equal(isLatestTag('v0.16.0', ['v0.15.0', 'v0.16.0', 'v0.9.9']), true);
  assert.equal(isLatestTag('v0.16.0', []), true);
});

test('an older tag pushed with or after a newer one does not take latest', () => {
  assert.equal(isLatestTag('v0.12.0', ['v0.12.0', 'v0.13.0']), false);
  assert.equal(isLatestTag('v0.15.2', ['v0.16.0', 'v0.15.2']), false);
  assert.equal(isLatestTag('v0.9.0', ['v0.10.0']), false, 'compared as numbers, not strings');
});

test('prereleases never take latest and are ignored as rivals', () => {
  assert.equal(isLatestTag('v0.17.0-rc.1', ['v0.16.0']), false);
  assert.equal(isLatestTag('v0.16.0', ['v0.17.0-rc.1']), true);
  assert.deepEqual(parseStable('v1.2.3'), [1, 2, 3]);
  assert.equal(parseStable('latest'), undefined);
});
