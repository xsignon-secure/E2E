import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDoctorReport, runDoctor, runDoctorChecks, toolsCheck } from '../dist/cli/doctor.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'pw-doctor-'));
}

const byName = (report, name) => report.checks.find((c) => c.name === name);

test('an empty folder fails on the config and on Playwright, with fixes', async () => {
  const root = tempProject();
  const home = tempProject();
  try {
    const report = await runDoctorChecks(root, home, { update: { offline: true } });
    assert.equal(report.ok, false);
    assert.equal(byName(report, 'Node.js').status, 'ok');
    assert.equal(byName(report, 'Playwright config').status, 'fail');
    assert.equal(byName(report, 'Playwright').status, 'fail');
    assert.match(byName(report, 'Playwright').fix, /@playwright\/test/);
    assert.equal(byName(report, 'MCP clients').status, 'warn');
    assert.match(byName(report, 'Agent skill').fix, /init/);
    assert.match(renderDoctorReport(report), /2 problems to fix/);
    assert.doesNotMatch(renderDoctorReport(report), /star/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a set-up project passes the config, install, tests, clients and skill checks', async () => {
  const root = tempProject();
  const home = tempProject();
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"p"}');
    writeFileSync(path.join(root, 'playwright.config.ts'), "export default { testDir: 'tests' };\n");
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'a.spec.ts'), '');
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'playwright-e2e': { command: 'npx' } } }));
    mkdirSync(path.join(root, '.agents', 'skills', 'playwright-e2e-mcp'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'skills', 'playwright-e2e-mcp', 'SKILL.md'), '# skill');

    const report = await runDoctorChecks(root, home, { update: { offline: true } });
    assert.equal(byName(report, 'Playwright config').status, 'ok');
    assert.match(byName(report, 'Playwright').detail, /^@playwright\/test \d/);
    // Browser state depends on the machine; the check must still be there.
    assert.ok(byName(report, 'Browsers'));
    assert.deepEqual(byName(report, 'Test files'), { name: 'Test files', status: 'ok', detail: '1 found' });
    assert.match(byName(report, 'MCP clients').detail, /Claude Code/);
    assert.equal(byName(report, 'Agent skill').status, 'ok');
    if (report.ok) assert.match(renderDoctorReport(report), /A star helps other Playwright users find it: https:\/\/github\.com\/xsignon-secure\/E2E\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('runDoctor prints JSON, exits 1 on a failure and 2 on bad arguments', async () => {
  const root = tempProject();
  try {
    let printed = '';
    const code = await runDoctor(['--project-root', root, '--json', '--offline'], (t) => {
      printed += t;
    });
    assert.equal(code, 1);
    const report = JSON.parse(printed);
    assert.equal(report.ok, false);
    assert.ok(Array.isArray(report.checks));
    assert.equal(await runDoctor(['--bogus'], () => undefined), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tools check warns when all tools are exposed and suggests core profile', async () => {
  const root = tempProject();
  const home = tempProject();
  const orig = process.env.PW_MCP_TOOLS;
  try {
    delete process.env.PW_MCP_TOOLS;
    const defaultCheck = toolsCheck();
    assert.equal(defaultCheck.name, 'Tools');
    assert.equal(defaultCheck.status, 'warn');
    assert.match(defaultCheck.detail, /20 tools exposed/);
    assert.match(defaultCheck.detail, /tokens \/ request/);
    assert.match(defaultCheck.fix, /--tools=core/);

    const coreCheck = toolsCheck('core');
    assert.equal(coreCheck.status, 'ok');
    assert.match(coreCheck.detail, /7 tools exposed/);
    assert.match(coreCheck.detail, /tokens \/ request/);
    assert.equal(coreCheck.fix, undefined);

    // Verify integration inside runDoctorChecks
    delete process.env.PW_MCP_TOOLS;
    const reportAll = await runDoctorChecks(root, home, { update: { offline: true } });
    assert.equal(byName(reportAll, 'Tools').status, 'warn');

    process.env.PW_MCP_TOOLS = 'core';
    const reportCore = await runDoctorChecks(root, home, { update: { offline: true } });
    assert.equal(byName(reportCore, 'Tools').status, 'ok');
  } finally {
    if (orig !== undefined) process.env.PW_MCP_TOOLS = orig;
    else delete process.env.PW_MCP_TOOLS;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
