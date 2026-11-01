# History server for playwright-e2e-mcp

A small server that collects test runs from every CI job and laptop into one history, so
`analyze-history` can rank flaky and broken tests across all of them and name the commit
where each one went bad. It comes with a dashboard. It is free and MIT like the rest of the
repo, and you host it yourself: there are no accounts, no billing and no data sent to anyone
but the server you run.

```
CI job ── playwright-e2e-mcp ci ──► .playwright-e2e-mcp/history.jsonl
       └─ playwright-e2e-mcp upload ──POST /api/v1/runs──► history server ──► file or Postgres
laptop ── analyze-history (source: both) ──GET /api/v1/runs──┘
browser ── / (dashboard) ──GET /api/v1/summary──┘
```

## 1. Make a token

Anyone with a token can upload and read runs, so treat it like a password. Make one per team:

```bash
openssl rand -hex 24
```

`HISTORY_TOKENS` lists them. Each `team:token` pair gets its own space; a team never sees
another team's runs:

```bash
HISTORY_TOKENS="web:9f2c…,mobile:41aa…"   # two teams
HISTORY_TOKENS="9f2c…"                     # one shared space
```

## 2. Run it

Pick one.

**Docker (any machine or VM).** Runs are kept in a volume:

```bash
docker build -t pw-history https://github.com/xsignon-secure/E2E.git#main:history-server
docker run -d --name pw-history -p 8787:8787 \
  -e HISTORY_TOKENS="web:<token>" -v pw-history:/data pw-history
```

**Plain Node 22.** Runs are kept in `HISTORY_DATA_DIR/history.json`:

```bash
cd history-server && npm ci --omit=dev
HISTORY_TOKENS="web:<token>" HISTORY_DATA_DIR=./data node server.mjs
```

Put either one behind HTTPS (Caddy, nginx, or your platform's TLS). The MCP only sends a
token over plain `http` to `localhost`.

**Vercel (free plan).** New Project, import the repo, set **Root Directory** to
`history-server`, framework "Other", no build command. Add `HISTORY_TOKENS` and a
`DATABASE_URL` from a free Postgres (for example [Neon](https://neon.tech)); serverless
functions have no disk to keep runs on. The table is created on first use (`schema.sql`
has the same DDL).

**Azure Functions.** `azure/functions.mjs` serves the same API and dashboard. Create a
Function App (Flex Consumption, Node.js 22, Linux), point Deployment Center at this repo
with `history-server` as the app folder, and set `HISTORY_TOKENS` and `DATABASE_URL` as
environment variables.

Check it: `curl https://<your-server>/api/v1/health` answers `{"ok":true,...}`, and
`https://<your-server>/` opens the dashboard (paste a token).

## 3. Point the MCP at it

GitHub Action:

```yaml
- uses: xsignon-secure/E2E@v0.9.0
  with:
    history-url: https://<your-server>
    history-token: ${{ secrets.PW_MCP_HISTORY_TOKEN }}
```

Any other CI, after the test run:

```bash
PW_MCP_HISTORY_URL=https://<your-server> PW_MCP_HISTORY_TOKEN=<token> npx -y playwright-e2e-mcp upload
```

On your laptop, add `PW_MCP_HISTORY_URL` and `PW_MCP_HISTORY_TOKEN` to the MCP server's
`env`. `analyze-history` then merges the server's runs with local ones. Runs are filed under
the GitHub repository name (`owner/repo`); `PW_MCP_HISTORY_PROJECT` overrides it.

The 0.7 and 0.8 names (`PW_MCP_PRO_KEY`, `PW_MCP_PRO_URL`, and the Action's `pro-key` /
`pro-url`) still work, so `xsignon-secure/E2E@v0.8.0` with `pro-url` and `pro-key` talks to
this server too.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `HISTORY_TOKENS` | required | `team:token` pairs or bare tokens, comma separated; 16+ characters each |
| `DATABASE_URL` | — | Postgres connection string (serverless hosts) |
| `HISTORY_DATA_DIR` | — | Folder for `history.json` (single server, Docker sets `/data`) |
| `HISTORY_MAX_PROJECTS` | 20 | Projects per team |
| `HISTORY_MAX_RUNS` | 5000 | Runs kept per project; the oldest go first |
| `HISTORY_RETENTION_DAYS` | 90 | Runs older than this are dropped |
| `PORT` / `HOST` | 8787 / 0.0.0.0 | Where `server.mjs` listens |

With neither `DATABASE_URL` nor `HISTORY_DATA_DIR`, runs live in memory and are lost on
restart, which is only good for trying it out.

## API

Every call except health needs `Authorization: Bearer <token>`.

| Endpoint | |
| --- | --- |
| `GET /api/v1/health` | no token |
| `POST /api/v1/runs` | `{ project, runs: HistoryEntry[] }`, at most 200 runs or 4 MB |
| `GET /api/v1/runs?project=&limit=` | oldest first, limit ≤ 1000 |
| `GET /api/v1/projects` | projects with run counts |
| `GET /api/v1/summary?project=&lastRuns=` | flaky and broken tests (the dashboard) |
| `DELETE /api/v1/projects?project=` | delete a project's runs |

Uploads are cut down to the fields the MCP writes (test names, statuses, durations, error
messages up to 1,000 characters, commit, branch, build URL), with size caps. Tokens are
never stored; a bare token's space is named after its hash.

## Code

`lib/handler.mjs` (Web `Request` → `Response`, no framework), `lib/tokens.mjs` (who may
call), `lib/store.mjs` (memory, file and Postgres), `lib/summary.mjs`, `lib/app.mjs`
(configuration), `server.mjs` (plain Node), `api/v1.mjs` (Vercel), `azure/functions.mjs`
(Azure Functions), `public/` (dashboard).

```bash
npm ci && npm test   # no network or database needed
```
