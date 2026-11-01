/**
 * The dashboard's numbers: per-test pass/fail strips across stored runs,
 * with the same buckets as the MCP's analyze-history (flaky, broken).
 * Deliberately small; the MCP does the deep analysis once it has the runs.
 */

const FAILED = new Set(['failed', 'timedOut', 'interrupted']);

const letter = (status) => (status === 'passed' ? 'P' : FAILED.has(status) ? 'F' : status === 'flaky' ? '~' : '-');

export function summarize(runs) {
  const tests = new Map();
  for (const run of runs) {
    for (const t of run.tests ?? []) {
      const key = `${t.file}\u0000${t.title}\u0000${t.project ?? ''}`;
      const slot = tests.get(key) ?? { file: t.file, title: t.title, project: t.project, statuses: [], lastMsg: undefined, lastAt: run.at };
      slot.statuses.push(t.status);
      if (t.msg && t.status !== 'passed') slot.lastMsg = t.msg.split('\n')[0].slice(0, 200);
      slot.lastAt = run.at;
      tests.set(key, slot);
    }
  }
  const flaky = [];
  const broken = [];
  for (const slot of tests.values()) {
    const ran = slot.statuses.filter((s) => s !== 'skipped' && s !== 'unknown');
    if (ran.length === 0) continue;
    const bad = ran.filter((s) => s !== 'passed').length;
    let flips = 0;
    for (let i = 1; i < ran.length; i += 1) if ((ran[i - 1] === 'passed') !== (ran[i] === 'passed')) flips += 1;
    const row = {
      file: slot.file,
      title: slot.title,
      ...(slot.project ? { project: slot.project } : {}),
      runs: ran.length,
      failRate: Math.round((bad / ran.length) * 100) / 100,
      flips,
      strip: slot.statuses.map(letter).join('').slice(-30),
      lastStatus: slot.statuses[slot.statuses.length - 1],
      ...(slot.lastMsg ? { lastError: slot.lastMsg } : {}),
    };
    const lastBad = FAILED.has(row.lastStatus);
    if (lastBad && (flips === 0 || ran.slice(-3).every((s) => FAILED.has(s)))) broken.push(row);
    else if (bad > 0 && flips > 0) flaky.push(row);
    else if (ran.includes('flaky')) flaky.push(row);
  }
  flaky.sort((a, b) => b.flips - a.flips || b.failRate - a.failRate);
  broken.sort((a, b) => b.failRate - a.failRate);
  const passedRuns = runs.filter((r) => r.ok).length;
  return {
    runs: runs.length,
    passRate: runs.length ? Math.round((passedRuns / runs.length) * 100) / 100 : null,
    firstAt: runs[0]?.at ?? null,
    lastAt: runs[runs.length - 1]?.at ?? null,
    tests: tests.size,
    flaky: flaky.slice(0, 50),
    broken: broken.slice(0, 50),
  };
}
