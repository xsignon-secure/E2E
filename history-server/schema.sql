-- History server schema. Run once against the Postgres database (Neon or any
-- Postgres): psql "$DATABASE_URL" -f schema.sql
-- The handler also creates it on first use, so this file is for review and
-- for databases where the app user may not run DDL.

CREATE TABLE IF NOT EXISTS history_runs (
  id          BIGSERIAL PRIMARY KEY,
  team        TEXT        NOT NULL,          -- team from HISTORY_TOKENS, never the token itself
  project     TEXT        NOT NULL,          -- e.g. "acme/shop"
  at          TIMESTAMPTZ NOT NULL,          -- when the run happened
  command     TEXT        NOT NULL,
  ok          BOOLEAN     NOT NULL,
  entry       JSONB       NOT NULL,          -- the history entry, as the MCP writes it
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team, project, at, command)
);

CREATE INDEX IF NOT EXISTS history_runs_by_project ON history_runs (team, project, at DESC);
