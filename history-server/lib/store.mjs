/**
 * Where runs are kept. Three implementations with the same methods:
 * memoryStore for tests, fileStore for a single machine (HISTORY_DATA_DIR,
 * used by server.mjs and the Docker image), and postgresStore for serverless
 * hosts (any Postgres through DATABASE_URL, e.g. a free Neon database).
 *
 * Every call is scoped to one team (one token), so one team can never read
 * or delete another's runs.
 */

/** Limits per team; old runs fall off first. Override with HISTORY_MAX_* (see app.mjs). */
export const LIMITS = {
  projects: 20,
  runsPerProject: 5_000,
  retentionDays: 90,
};

const runKey = (run) => `${run.at}\u0000${run.command}`;

export function memoryStore(initial) {
  /** team → project → Map(runKey → run) */
  const data = new Map();
  for (const [team, projects] of Object.entries(initial ?? {})) {
    const map = new Map();
    for (const [project, runs] of Object.entries(projects)) map.set(project, new Map(runs.map((run) => [runKey(run), run])));
    data.set(team, map);
  }
  const projectsOf = (team) => {
    if (!data.has(team)) data.set(team, new Map());
    return data.get(team);
  };
  const cutoff = () => new Date(Date.now() - LIMITS.retentionDays * 86_400_000).toISOString();

  return {
    /** Everything, as plain JSON (fileStore writes this to disk). */
    snapshot() {
      const out = {};
      for (const [team, projects] of data) {
        out[team] = {};
        for (const [project, map] of projects) out[team][project] = [...map.values()];
      }
      return out;
    },
    async projectCount(team) {
      return projectsOf(team).size;
    },
    async hasProject(team, project) {
      return projectsOf(team).has(project);
    },
    async addRuns(team, project, runs) {
      const projects = projectsOf(team);
      if (!projects.has(project)) projects.set(project, new Map());
      const map = projects.get(project);
      let stored = 0;
      for (const run of runs) {
        const key = runKey(run);
        if (map.has(key)) continue;
        map.set(key, run);
        stored += 1;
      }
      const old = cutoff();
      const sorted = [...map.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [key, run] of sorted) {
        if (map.size <= LIMITS.runsPerProject && run.at >= old) break;
        map.delete(key);
      }
      return stored;
    },
    async listRuns(team, project, limit) {
      const map = projectsOf(team).get(project);
      if (!map) return [];
      return [...map.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
    },
    async listProjects(team) {
      return [...projectsOf(team).entries()].map(([name, map]) => {
        const runs = [...map.values()];
        return { project: name, runs: runs.length, lastAt: runs.reduce((m, r) => (r.at > m ? r.at : m), '') || null };
      });
    },
    async deleteProject(team, project) {
      const map = projectsOf(team).get(project);
      const count = map ? map.size : 0;
      projectsOf(team).delete(project);
      return count;
    },
  };
}

/**
 * One JSON file on disk, for a single server (a VM, a container, a spare
 * machine). Writes go to a temp file and are renamed into place, so a crash
 * mid-write never leaves a half-written history.
 */
export async function fileStore(dir) {
  const { mkdir, readFile, rename, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'history.json');
  const initial = await readFile(file, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return {};
    throw new Error(`${file} is not readable JSON: ${error.message}`);
  });
  const memory = memoryStore(initial);
  let queue = Promise.resolve();
  const save = () =>
    (queue = queue.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(memory.snapshot()), 'utf8');
      await rename(tmp, file);
    }));
  return {
    ...memory,
    async addRuns(team, project, runs) {
      const stored = await memory.addRuns(team, project, runs);
      await save();
      return stored;
    },
    async deleteProject(team, project) {
      const deleted = await memory.deleteProject(team, project);
      await save();
      return deleted;
    },
  };
}

/** Postgres through @neondatabase/serverless (HTTP; fine on serverless functions). */
export async function postgresStore(databaseUrl) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(databaseUrl);
  let ready;
  const ensureSchema = () =>
    (ready ??= (async () => {
      await sql`CREATE TABLE IF NOT EXISTS history_runs (
        id BIGSERIAL PRIMARY KEY,
        team TEXT NOT NULL,
        project TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        command TEXT NOT NULL,
        ok BOOLEAN NOT NULL,
        entry JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (team, project, at, command)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS history_runs_by_project ON history_runs (team, project, at DESC)`;
    })());

  return {
    async projectCount(team) {
      await ensureSchema();
      const rows = await sql`SELECT count(DISTINCT project)::int AS n FROM history_runs WHERE team = ${team}`;
      return rows[0]?.n ?? 0;
    },
    async hasProject(team, project) {
      await ensureSchema();
      const rows = await sql`SELECT 1 FROM history_runs WHERE team = ${team} AND project = ${project} LIMIT 1`;
      return rows.length > 0;
    },
    async addRuns(team, project, runs) {
      await ensureSchema();
      let stored = 0;
      for (const run of runs) {
        const rows = await sql`INSERT INTO history_runs (team, project, at, command, ok, entry)
          VALUES (${team}, ${project}, ${run.at}, ${run.command}, ${run.ok}, ${JSON.stringify(run)}::jsonb)
          ON CONFLICT (team, project, at, command) DO NOTHING RETURNING id`;
        stored += rows.length;
      }
      await sql`DELETE FROM history_runs WHERE team = ${team} AND project = ${project}
        AND (at < now() - make_interval(days => ${LIMITS.retentionDays})
          OR id NOT IN (SELECT id FROM history_runs WHERE team = ${team} AND project = ${project}
                        ORDER BY at DESC LIMIT ${LIMITS.runsPerProject}))`;
      return stored;
    },
    async listRuns(team, project, limit) {
      await ensureSchema();
      const rows = await sql`SELECT entry FROM history_runs WHERE team = ${team} AND project = ${project}
        ORDER BY at DESC LIMIT ${limit}`;
      return rows.map((r) => r.entry).reverse();
    },
    async listProjects(team) {
      await ensureSchema();
      const rows = await sql`SELECT project, count(*)::int AS runs, max(at) AS last_at FROM history_runs
        WHERE team = ${team} GROUP BY project ORDER BY max(at) DESC`;
      return rows.map((r) => ({ project: r.project, runs: r.runs, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null }));
    },
    async deleteProject(team, project) {
      await ensureSchema();
      const rows = await sql`DELETE FROM history_runs WHERE team = ${team} AND project = ${project} RETURNING id`;
      return rows.length;
    },
  };
}
