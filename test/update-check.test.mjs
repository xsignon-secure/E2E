import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, compareVersions, REGISTRY_LATEST_URL } from '../dist/utils/update-check.js';
import { versionCheck } from '../dist/cli/doctor.js';
import { SERVER_VERSION } from '../dist/server.js';

const reply = (body, status = 200) => async (url) => {
  assert.equal(url, REGISTRY_LATEST_URL);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

test('compareVersions orders releases and pre-releases', () => {
  assert.equal(compareVersions('0.7.0', '0.8.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
});

test('checkForUpdate reports outdated, current and ahead', async () => {
  assert.deepEqual(await checkForUpdate('0.7.0', { fetchImpl: reply({ version: '0.8.0' }), env: {} }), {
    state: 'outdated',
    current: '0.7.0',
    latest: '0.8.0',
  });
  assert.equal((await checkForUpdate('0.8.0', { fetchImpl: reply({ version: '0.8.0' }), env: {} })).state, 'current');
  assert.equal((await checkForUpdate('0.9.0', { fetchImpl: reply({ version: '0.8.0' }), env: {} })).state, 'ahead');
});

test('checkForUpdate never throws and can be switched off', async () => {
  const failing = async () => {
    throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
  };
  assert.equal((await checkForUpdate('0.8.0', { fetchImpl: failing, env: {} })).state, 'unknown');
  assert.equal((await checkForUpdate('0.8.0', { fetchImpl: reply({}, 503), env: {} })).state, 'unknown');
  assert.equal((await checkForUpdate('0.8.0', { fetchImpl: reply({ version: 'nope' }), env: {} })).state, 'unknown');
  let called = false;
  const spy = async () => {
    called = true;
    return new Response('{}');
  };
  assert.equal((await checkForUpdate('0.8.0', { offline: true, fetchImpl: spy, env: {} })).state, 'skipped');
  assert.equal((await checkForUpdate('0.8.0', { fetchImpl: spy, env: { PW_MCP_NO_UPDATE_CHECK: '1' } })).state, 'skipped');
  assert.equal(called, false);
});

test('doctor warns with the upgrade commands when a newer version is out', async () => {
  const check = await versionCheck({ fetchImpl: reply({ version: '99.0.0' }), env: {} });
  assert.equal(check.status, 'warn');
  assert.match(check.detail, new RegExp(`^${SERVER_VERSION.replace(/\./g, '\\.')} is running; 99\\.0\\.0 is out`));
  assert.match(check.fix, /npm install -D playwright-e2e-mcp@latest/);
  assert.match(check.fix, /restart your MCP client/);
  const offline = await versionCheck({ offline: true });
  assert.equal(offline.status, 'ok');
  assert.match(offline.detail, /did not check for updates/);
});
