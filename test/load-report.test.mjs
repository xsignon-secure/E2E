import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath } from '../dist/utils/path-utils.js';
import { foreignRebase, parseReportJson, reportGitInfo } from '../dist/utils/report-parser.js';
import { loadReportTool } from '../dist/tools/load-report.js';
import { createToolStore } from '../dist/tools/shared.js';
import { logger } from '../dist/utils/logger.js';

const CI = '/home/runner/work/app/app';

function ciReport() {
  return {
    config: {
      rootDir: `${CI}/tests`,
      configFile: `${CI}/playwright.config.ts`,
      projects: [{ name: 'chromium' }],
      metadata: {
        gitCommit: { hash: 'abc1234def5678', shortHash: 'abc1234', subject: 'Make cart async', branch: 'main' },
        ci: { buildHref: 'https://github.com/o/r/actions/runs/1', commitHash: 'abc1234def5678' },
      },
    },
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 4_000 },
    suites: [
      {
        title: 'cart.spec.ts',
        file: 'cart.spec.ts',
        specs: [
          {
            title: 'adds an item',
            file: 'cart.spec.ts',
            line: 3,
            tests: [
              {
                projectName: 'chromium',
                results: [
                  {
                    status: 'failed',
                    retry: 0,
                    duration: 1_200,
                    error: { message: 'expect(locator).toHaveText(expected)', stack: `Error\n    at ${CI}/tests/cart.spec.ts:5:7` },
                    attachments: [{ name: 'trace', contentType: 'application/zip', path: `${CI}/test-results/cart-adds-an-item-chromium/trace.zip` }],
                  },
                ],
              },
            ],
          },
          {
            title: 'shows total',
            file: 'cart.spec.ts',
            line: 9,
            tests: [{ projectName: 'chromium', results: [{ status: 'passed', retry: 0, duration: 800 }] }],
          },
        ],
      },
    ],
  };
}

test('reportGitInfo reads commit, branch, subject and build link', () => {
  assert.deepEqual(reportGitInfo(ciReport()), {
    commit: 'abc1234def5678',
    branch: 'main',
    subject: 'Make cart async',
    buildUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.equal(reportGitInfo({ config: {} }), undefined);
});

test('foreignRebase maps the CI checkout onto the local root only for foreign reports', () => {
  const rebase = foreignRebase(`${CI}/playwright.config.ts`, '/local/app', { traceDirs: [] });
  assert.equal(rebase(`${CI}/tests/a.spec.ts`), '/local/app/tests/a.spec.ts');
  assert.equal(rebase('/elsewhere/x'), '/elsewhere/x');
  assert.equal(foreignRebase(`${CI}/playwright.config.ts`, '/local/app', undefined)(`${CI}/x`), `${CI}/x`);
  assert.equal(foreignRebase('/local/app/playwright.config.ts', '/local/app', { traceDirs: [] })('/local/app/x'), '/local/app/x');
});

test('parseReportJson finds a CI trace in the unpacked artifact folder', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-foreign-')));
  const artifact = path.join(root, 'ci-artifacts', 'cart-adds-an-item-chromium');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(path.join(artifact, 'trace.zip'), 'zip');
  const parsed = parseReportJson(JSON.stringify(ciReport()), root, undefined, { traceDirs: [path.join(root, 'ci-artifacts')] });
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].file, 'tests/cart.spec.ts');
  assert.equal(parsed.failures[0].tracePath, normalizePath(path.join(root, 'ci-artifacts', 'cart-adds-an-item-chromium', 'trace.zip')));
  assert.equal(parsed.git?.commit, 'abc1234def5678');
  // Without the foreign option, CI paths outside the root are never followed.
  assert.equal(parseReportJson(JSON.stringify(ciReport()), root).failures[0].tracePath, undefined);
});

test('load-report imports a CI run as the last run and records its commit', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-load-')));
  mkdirSync(path.join(root, 'ci', 'test-results', 'cart-adds-an-item-chromium'), { recursive: true });
  writeFileSync(path.join(root, 'ci', 'results.json'), JSON.stringify(ciReport()));
  writeFileSync(path.join(root, 'ci', 'test-results', 'cart-adds-an-item-chromium', 'trace.zip'), 'zip');
  const store = createToolStore();
  const ctx = { logger: logger.child({ tool: 'test' }), store, projectRoot: root };
  const result = await loadReportTool.handler({ report: 'ci/results.json' }, ctx);
  const text = result.content[0].text;
  assert.ok(!result.isError, text);
  assert.match(text, /## Imported run —/);
  assert.match(text, /commit `abc1234d` on `main`/);
  assert.match(text, /\*\*Traces:\*\* found for all 1 failure/);
  assert.match(text, /\*\*History:\*\* recorded/);
  assert.equal(store.lastRun?.result.imported?.git?.commit, 'abc1234def5678');
  const history = readFileSync(path.join(root, '.playwright-e2e-mcp', 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'load-report');
  assert.equal(history[0].commit, 'abc1234def5678');
  assert.equal(history[0].subject, 'Make cart async');
});

test('load-report refuses paths outside the project and restricted servers', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-load-')));
  const ctx = { logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot: root };
  const outside = await loadReportTool.handler({ report: '../x.json' }, ctx);
  assert.equal(outside.isError, true);
  const missing = await loadReportTool.handler({ report: 'nope.json' }, ctx);
  assert.match(missing.content[0].text, /gh run download/);
  const restricted = await loadReportTool.handler({ report: 'x.json' }, { ...ctx, restricted: true });
  assert.match(restricted.content[0].text, /not available on this server/);
});

// ---- CI run URLs (GitHub Actions / GitLab) ----
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { parseCiRunRef, unzipInto, findReport } from '../dist/utils/ci-artifacts.js';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const body = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('parseCiRunRef recognises GitHub and GitLab run URLs', () => {
  const gh = parseCiRunRef('https://github.com/acme/shop/actions/runs/123456/job/9?pr=3');
  assert.equal(gh.provider, 'github');
  assert.deepEqual([gh.owner, gh.repo, gh.runId], ['acme', 'shop', '123456']);
  assert.equal(parseCiRunRef('github://acme/shop/runs/7').runId, '7');
  const gl = parseCiRunRef('https://gitlab.example.com/group/sub/app/-/jobs/42');
  assert.deepEqual([gl.provider, gl.project, gl.jobId, gl.api], ['gitlab', 'group/sub/app', '42', 'https://gitlab.example.com/api/v4']);
  assert.equal(parseCiRunRef('ci-artifacts/results.json'), undefined);
  assert.equal(parseCiRunRef('https://github.com/acme/shop/pull/3'), undefined);
});

test('unzipInto refuses entries that escape the folder', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pwmcp-unzip-'));
  const written = await unzipInto(zip([['ok/a.txt', 'a'], ['../evil.txt', 'x'], ['/abs.txt', 'y']]), normalizePath(dir));
  assert.equal(readFileSync(path.join(dir, 'ok/a.txt'), 'utf8'), 'a');
  assert.ok(written <= 2);
  assert.throws(() => readFileSync(path.join(dir, '..', 'evil.txt')));
});

test('load-report downloads a GitHub Actions run and loads its report', async () => {
  const root = normalizePath(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pwmcp-ci-'))));
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'tests/cart.spec.ts'), "import { test } from '@playwright/test';\n");
  const report = zip([['results.json', JSON.stringify(ciReport())]]);
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    const base = '/repos/acme/shop/actions/runs/99';
    if (req.url === base) return res.end(JSON.stringify({ head_sha: 'feedface1234', head_branch: 'fix-cart', html_url: 'https://github.com/acme/shop/actions/runs/99' }));
    if (req.url.startsWith(`${base}/artifacts`)) {
      return res.end(JSON.stringify({ artifacts: [
        { name: 'coverage', archive_download_url: `http://127.0.0.1:${server.address().port}/dl/cov` },
        { name: 'playwright-report', archive_download_url: `http://127.0.0.1:${server.address().port}/dl/report` },
      ] }));
    }
    if (req.url === '/dl/report') return res.end(report);
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { api: process.env.PW_MCP_GITHUB_API, token: process.env.GITHUB_TOKEN };
  process.env.PW_MCP_GITHUB_API = `http://127.0.0.1:${server.address().port}`;
  try {
    const ctx = { logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot: root };
    delete process.env.GITHUB_TOKEN;
    const saveGh = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    const noToken = await loadReportTool.handler({ report: 'https://github.com/acme/shop/actions/runs/99' }, ctx);
    assert.equal(noToken.isError, true);
    assert.match(noToken.content[0].text, /GITHUB_TOKEN/);
    if (saveGh) process.env.GH_TOKEN = saveGh;

    process.env.GITHUB_TOKEN = 'test-token';
    const result = await loadReportTool.handler({ report: 'https://github.com/acme/shop/actions/runs/99' }, ctx);
    const text = result.content[0].text;
    assert.notEqual(result.isError, true, text);
    assert.match(text, /Imported run/);
    assert.match(text, /feedface/);
    assert.match(text, /fix-cart/);
    assert.match(text, /playwright-report/);
    assert.ok(!seen.some(([url]) => url === '/dl/cov'), 'only report-like artifacts are downloaded');
    assert.ok(seen.every(([, auth]) => auth === 'Bearer test-token'));
    assert.equal(ctx.store.lastRun.result.failures.length, 1);
    assert.equal(ctx.store.lastRun.result.imported.git.commit, 'feedface1234');
    assert.match(readFileSync(path.join(root, '.playwright-e2e-mcp/ci/github-99/playwright-report/results.json'), 'utf8'), /suites/);
    assert.equal(await findReport(`${root}/.playwright-e2e-mcp/ci/github-99`), `${root}/.playwright-e2e-mcp/ci/github-99/playwright-report/results.json`);

    const bad = await loadReportTool.handler({ report: 'https://example.com/some/page' }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unrecognised CI URL/);
  } finally {
    server.close();
    if (saved.api === undefined) delete process.env.PW_MCP_GITHUB_API; else process.env.PW_MCP_GITHUB_API = saved.api;
    if (saved.token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.token;
  }
});
