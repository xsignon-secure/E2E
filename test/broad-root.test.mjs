/**
 * When the server starts in the home folder or the filesystem root, an
 * explicit projectRoot must be a real project folder: no hidden folders
 * (~/.ssh, ~/.aws) and a package.json, Playwright config or pytest config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolStore, isBroadRoot, resolveProjectRoot } from '../dist/tools/shared.js';
import { normalizePath } from '../dist/utils/path-utils.js';
import { logger } from '../dist/utils/logger.js';

const ctxFor = (projectRoot) => ({ logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot });

/** A fake home folder with a project, a non-project folder and a hidden one. */
function fakeHome() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-mcp-home-')));
  mkdirSync(path.join(home, 'code', 'shop'), { recursive: true });
  writeFileSync(path.join(home, 'code', 'shop', 'package.json'), '{}');
  mkdirSync(path.join(home, 'code', 'pyapp'), { recursive: true });
  writeFileSync(path.join(home, 'code', 'pyapp', 'pytest.ini'), '[pytest]\n');
  mkdirSync(path.join(home, 'Documents'), { recursive: true });
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeFileSync(path.join(home, '.ssh', 'package.json'), '{}');
  mkdirSync(path.join(home, '.config', 'app'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'app', 'package.json'), '{}');
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('isBroadRoot spots the home folder and filesystem roots only', () => {
  const home = fakeHome();
  assert.equal(isBroadRoot(home, home), true);
  assert.equal(isBroadRoot(`${home}/`, home), true);
  assert.equal(isBroadRoot(path.join(home, 'code'), home), false);
  assert.equal(isBroadRoot(path.parse(home).root, home), true);
  if (process.platform === 'win32') assert.equal(isBroadRoot('C:\\', home), true);
});

test('under a home-folder root, only real project folders can be picked', async () => {
  const home = fakeHome();
  await withHome(home, async () => {
    const ctx = ctxFor(home);
    assert.equal(await resolveProjectRoot('code/shop', ctx), normalizePath(path.join(home, 'code', 'shop')));
    assert.equal(await resolveProjectRoot('code/pyapp', ctx), normalizePath(path.join(home, 'code', 'pyapp')));
    for (const bad of ['.ssh', '.config/app', 'Documents', '.', home]) {
      await assert.rejects(resolveProjectRoot(bad, ctx), (error) => {
        assert.equal(error.kind, 'INVALID_PATH');
        assert.match(error.hint, /PW_MCP_PROJECT_ROOT/);
        return true;
      }, bad);
    }
    // No projectRoot: the default root itself, so page tools on a URL still work.
    assert.equal(await resolveProjectRoot(undefined, ctx), normalizePath(home));
  });
});

test('a normal project root is unchanged: hidden and bare folders are fine there', async () => {
  const home = fakeHome();
  await withHome(home, async () => {
    const root = path.join(home, 'code', 'shop');
    mkdirSync(path.join(root, '.cache', 'x'), { recursive: true });
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    const ctx = ctxFor(root);
    assert.equal(await resolveProjectRoot('tests', ctx), normalizePath(path.join(root, 'tests')));
    assert.equal(await resolveProjectRoot('.cache/x', ctx), normalizePath(path.join(root, '.cache', 'x')));
  });
});

test('a folder listed in PW_MCP_ALLOWED_ROOTS is trusted even under a broad root', async () => {
  const home = fakeHome();
  const extra = path.join(home, 'Documents');
  const saved = process.env.PW_MCP_ALLOWED_ROOTS;
  process.env.PW_MCP_ALLOWED_ROOTS = extra;
  try {
    await withHome(home, async () => {
      assert.equal(await resolveProjectRoot(extra, ctxFor(home)), normalizePath(extra));
    });
  } finally {
    if (saved === undefined) delete process.env.PW_MCP_ALLOWED_ROOTS;
    else process.env.PW_MCP_ALLOWED_ROOTS = saved;
  }
});
