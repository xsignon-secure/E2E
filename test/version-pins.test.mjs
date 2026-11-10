/**
 * Versions that are pinned in more than one place have to move together.
 *
 * - The Docker image's Playwright base, the CI templates' Playwright images
 *   and the pytest job's Python playwright must match the server's
 *   playwright-core, or the browsers they install are not the build the
 *   server launches (an unpinned pip install broke the pytest job on main).
 * - The CI templates run `npx -y playwright-e2e-mcp@<version>`, so a new
 *   release never changes a user's pipeline until they bump it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const playwright = pkg.dependencies['playwright-core'];

test('playwright-core is pinned to an exact version', () => {
  assert.match(playwright, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies['@playwright/test'], playwright);
});

test('the Dockerfile builds on the same Playwright image as playwright-core', () => {
  const froms = [...read('Dockerfile').matchAll(/^FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-/gm)].map((m) => m[1]);
  assert.ok(froms.length > 0);
  for (const version of froms) assert.equal(version, playwright);
});

test('the pytest-playwright CI job pins Python playwright to playwright-core', () => {
  const ci = read('.github/workflows/ci.yml');
  const pip = /pip" install[^\n]*/.exec(ci)?.[0] ?? '';
  assert.match(pip, /pytest-playwright==\d/, 'pytest-playwright must be pinned');
  assert.match(pip, new RegExp(`playwright==${playwright.replace(/\./g, '\\.')}(\\s|$)`), `playwright must be pinned to ${playwright}`);
});

const examples = readdirSync(new URL('../examples', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((dir) =>
    readdirSync(new URL(`../examples/${dir.name}`, import.meta.url))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `examples/${dir.name}/${name}`),
  );

test('CI templates pin playwright-e2e-mcp to this version', () => {
  for (const file of examples) {
    const text = read(file);
    for (const match of text.matchAll(/npx -y playwright-e2e-mcp(@[\w.-]+)?\s/g)) {
      assert.equal(match[1], `@${pkg.version}`, `${file}: ${match[0].trim()} should be playwright-e2e-mcp@${pkg.version}`);
    }
  }
});

test('CI templates use the Playwright image for playwright-core', () => {
  for (const file of examples) {
    for (const match of read(file).matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/g)) {
      assert.equal(match[1], playwright, `${file} uses Playwright ${match[1]}`);
    }
  }
});
