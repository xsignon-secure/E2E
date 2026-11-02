/**
 * load-report with a CI run URL: the user's GITHUB_TOKEN / GITLAB_TOKEN may
 * only go to a trusted API origin, and never follow a redirect to another
 * origin (artifact downloads redirect to storage).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTrustedApi, fetchCiRun, parseCiRunRef, trustedCiOrigins } from '../dist/utils/ci-artifacts.js';

const SECRETS = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'CI_JOB_TOKEN', 'PW_MCP_GITHUB_API', 'PW_MCP_GITLAB_API', 'PW_MCP_CI_HOSTS'];

/** Run `fn` with these env values set (undefined = unset), then restore. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(SECRETS.map((name) => [name, process.env[name]]));
  for (const name of SECRETS) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const name of SECRETS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** A local HTTP server that records the auth headers of every request. */
async function recorder(handler = (req, res) => { res.writeHead(404); res.end(); }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, privateToken: req.headers['private-token'], jobToken: req.headers['job-token'] });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { seen, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

const root = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-mcp-ci-')));

test('a run URL on an unknown host is refused before any token is sent', async () => {
  await withEnv({ GITHUB_TOKEN: 'ghp_SECRET', GITLAB_TOKEN: 'glpat_SECRET' }, async () => {
    for (const url of ['https://evil.example/acme/shop/actions/runs/1', 'https://evil.example/group/app/-/jobs/1', 'https://www.github.com/a/b/actions/runs/1']) {
      const ref = parseCiRunRef(url);
      assert.ok(ref, url);
      await assert.rejects(fetchCiRun(ref, root()), (error) => {
        assert.equal(error.kind, 'INVALID_INPUT');
        assert.match(error.message, /Not sending a CI token to (evil\.example|www\.github\.com)/);
        assert.match(error.hint, /PW_MCP_CI_HOSTS/);
        return true;
      });
    }
  });
});

test('the public hosts, the configured APIs and PW_MCP_CI_HOSTS are trusted', () => {
  const origins = trustedCiOrigins({ PW_MCP_GITHUB_API: 'https://ghe.acme.com/api/v3/', PW_MCP_CI_HOSTS: ' gitlab.acme.com , https://git.acme.io:8443/, bad host, ' });
  assert.ok(origins.has('https://api.github.com'));
  assert.ok(origins.has('https://gitlab.com'));
  assert.ok(origins.has('https://ghe.acme.com'));
  assert.ok(origins.has('https://gitlab.acme.com'));
  assert.ok(origins.has('https://git.acme.io:8443'));
  assert.equal([...origins].some((origin) => origin.includes('bad')), false);

  const github = parseCiRunRef('https://github.com/acme/shop/actions/runs/7');
  assert.doesNotThrow(() => assertTrustedApi(github, {}));
  const gitlab = parseCiRunRef('https://gitlab.com/group/app/-/jobs/7');
  assert.doesNotThrow(() => assertTrustedApi(gitlab, {}));
  const selfHosted = parseCiRunRef('https://gitlab.acme.com/group/app/-/jobs/7');
  assert.throws(() => assertTrustedApi(selfHosted, {}), /gitlab\.acme\.com/);
  assert.doesNotThrow(() => assertTrustedApi(selfHosted, { PW_MCP_CI_HOSTS: 'gitlab.acme.com' }));
  // http to a listed host is still refused: the list only trusts https.
  assert.throws(() => assertTrustedApi({ ...selfHosted, api: 'http://gitlab.acme.com/api/v4' }, { PW_MCP_CI_HOSTS: 'gitlab.acme.com' }));
});

test('a GitLab artifact redirect to another origin does not carry the token', async () => {
  const storage = await recorder();
  const api = await recorder((req, res) => {
    if (req.url.endsWith('/artifacts')) {
      res.writeHead(302, { location: `${storage.origin}/bucket/artifacts.zip?signature=x` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ commit: { id: 'abc1234' }, ref: 'main', web_url: 'https://gitlab.example/j/1' }));
  });
  try {
    await withEnv({ GITLAB_TOKEN: 'glpat_SECRET', PW_MCP_GITLAB_API: `${api.origin}/api/v4` }, async () => {
      const ref = parseCiRunRef('https://gitlab.example/group/app/-/jobs/1');
      await assert.rejects(fetchCiRun(ref, root()), /Artifact download answered 404/);
    });
    assert.equal(api.seen.length, 2);
    assert.ok(api.seen.every((request) => request.privateToken === 'glpat_SECRET'), 'the API itself gets the token');
    assert.equal(storage.seen.length, 1, 'the redirect was followed');
    assert.deepEqual(storage.seen[0], { url: '/bucket/artifacts.zip?signature=x', authorization: undefined, privateToken: undefined, jobToken: undefined });
  } finally {
    await api.close();
    await storage.close();
  }
});

test('a same-origin API redirect (renamed repository) keeps the token; a cross-origin one drops it', async () => {
  const other = await recorder();
  const api = await recorder((req, res) => {
    if (req.url.startsWith('/repos/acme/old/')) {
      res.writeHead(301, { location: req.url.replace('/repos/acme/old/', '/repos/acme/new/') });
      res.end();
      return;
    }
    if (req.url === '/repos/acme/new/actions/runs/5') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ head_sha: 'abc1234', head_branch: 'main' }));
      return;
    }
    res.writeHead(302, { location: `${other.origin}/leak` });
    res.end();
  });
  try {
    await withEnv({ GITHUB_TOKEN: 'ghp_SECRET', PW_MCP_GITHUB_API: api.origin }, async () => {
      const ref = parseCiRunRef('https://github.com/acme/old/actions/runs/5');
      await assert.rejects(fetchCiRun(ref, root()), /CI API answered 404/);
    });
    const renamed = api.seen.find((request) => request.url === '/repos/acme/new/actions/runs/5');
    assert.equal(renamed?.authorization, 'Bearer ghp_SECRET');
    assert.ok(other.seen.length >= 1);
    assert.ok(other.seen.every((request) => request.authorization === undefined));
  } finally {
    await api.close();
    await other.close();
  }
});

test('playwright-core ships as a dependency, at the same version as @playwright/test', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['playwright-core'], 'pytest projects and the Docker image rely on it');
  assert.equal(pkg.dependencies['playwright-core'], pkg.devDependencies['@playwright/test']);
});
