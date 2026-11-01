/**
 * The configured handler, shared by every host (server.mjs, Vercel, Azure
 * Functions). Configuration is environment variables:
 *
 *   HISTORY_TOKENS          required: "team:token,team2:token2" or "token"
 *   DATABASE_URL            Postgres (serverless hosts), e.g. a free Neon database
 *   HISTORY_DATA_DIR        a folder for history.json (single server, Docker)
 *   HISTORY_MAX_PROJECTS    projects per team (default 20)
 *   HISTORY_MAX_RUNS        runs kept per project (default 5000)
 *   HISTORY_RETENTION_DAYS  days runs are kept (default 90)
 *
 * With neither DATABASE_URL nor HISTORY_DATA_DIR runs live in memory and are
 * lost on restart, which is only good for trying it out.
 */

import { createHandler } from './handler.mjs';
import { tokenValidator } from './tokens.mjs';
import { fileStore, LIMITS, memoryStore, postgresStore } from './store.mjs';

let handler;

function applyLimits(env) {
  const set = (key, name) => {
    const value = Number.parseInt(env[name] ?? '', 10);
    if (Number.isFinite(value) && value > 0) LIMITS[key] = value;
  };
  set('projects', 'HISTORY_MAX_PROJECTS');
  set('runsPerProject', 'HISTORY_MAX_RUNS');
  set('retentionDays', 'HISTORY_RETENTION_DAYS');
}

export async function createStore(env = process.env) {
  if (env.DATABASE_URL) return postgresStore(env.DATABASE_URL);
  if (env.HISTORY_DATA_DIR) return fileStore(env.HISTORY_DATA_DIR);
  console.warn('history-server: no DATABASE_URL or HISTORY_DATA_DIR, keeping runs in memory (lost on restart)');
  return memoryStore();
}

export async function getHandler(env = process.env) {
  if (handler) return handler;
  applyLimits(env);
  const validate = tokenValidator(env);
  handler = createHandler({ store: await createStore(env), validate });
  return handler;
}

/** Headers for every response, the same set vercel.json adds on Vercel. */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
