# Setup: connecting the playwright-e2e-mcp server

This skill only gives the agent instructions. The tools come from the
`playwright-e2e-mcp` MCP server, which must be connected to the agent.

## Requirements

- playwright-e2e-mcp **0.2.0 or newer**, 0.4.0 recommended. `suggest-fix`,
  `get-run-status`, `analyze-history`, verified locators and signed-in page
  inspection arrived in 0.2.0; per-test flaky verdicts, `isolate`, tool profiles
  and the `ci` command in 0.3.0; `audit-accessibility`, the `order` check
  (needs Playwright 1.64+) and root-cause grouping in 0.4.0. Check with
  `npx -y playwright-e2e-mcp --version`.

- Node.js 22 or newer.
- A project with `@playwright/test` installed and a browser available:
  `npx playwright install chromium`.

## Install the server

The server is published on npm as `playwright-e2e-mcp` and in the official MCP
Registry as `io.github.xsignon-secure/E2E`. Pin a version in shared configs
(`playwright-e2e-mcp@<version>`) so every machine runs the same build.

**Claude Code**

```bash
claude mcp add playwright-e2e -- npx -y playwright-e2e-mcp
```

**Claude Desktop, Cursor, Windsurf, Gemini CLI, Qwen Code and other JSON-config clients**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "npx",
      "args": ["-y", "playwright-e2e-mcp"],
      "env": { "PW_MCP_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

Claude Desktop also has a one-click `.mcpb` extension on the project's
[GitHub releases](https://github.com/xsignon-secure/E2E/releases); it asks for the
project root on install.

**Codex CLI**

```toml
# ~/.codex/config.toml
[mcp_servers.playwright-e2e]
command = "npx"
args = ["-y", "playwright-e2e-mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

Raise the timeouts as shown: a Playwright run with retries takes longer than
Codex's 60-second default tool timeout.

## Install the skill

Copy the `playwright-e2e-mcp/` folder (the one holding `SKILL.md`) into your
agent's skills directory, for example:

- Claude Code: `~/.claude/skills/` (personal) or `.claude/skills/` (project)
- Codex CLI: `~/.codex/skills/`
- Other agents: their documented skills folder

## Environment variables

Set these in the server's `env` block. None of them are secrets except
`PW_MCP_HTTP_TOKEN`; never put a token in a committed config file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PW_MCP_PROJECT_ROOT` | server working directory | Default project root for every tool |
| `PW_MCP_TOOLS` | all | Tools to expose: names and/or profiles `core`, `triage`, `inspect`, `author` (same as the `--tools=` flag). `core` cuts the tool-definition context by about four fifths; `auto` starts with `core` plus `load-tools`, which loads the other tools when you need them |
| `PW_MCP_ALLOWED_ROOTS` | none | Extra directories allowed as `projectRoot` (`:`-separated, `;` on Windows) |
| `PW_MCP_BLOCK_PRIVATE_URLS` | off for stdio | `1` makes the URL tools refuse loopback, private-network and cloud-metadata addresses |
| `PW_MCP_STORAGE_STATE` | none | Default Playwright storageState JSON (inside the project) for the page tools, so signed-in pages open logged in |
| `PW_MCP_SHUFFLE_SEEDS` | random | Seeds for `diagnose-flaky`'s `order` pass (comma separated), to replay reported orders |
| `PW_MCP_LOGIN_ENV` | — | Extra variables `save-login` may type through `{{env:NAME}}`, comma separated (default: only `E2E_*`, `TEST_*`, `PW_*`, `PLAYWRIGHT_*`, `LOGIN_*`) |
| `PW_MCP_HISTORY_URL` / `PW_MCP_HISTORY_TOKEN` | — | Optional, free: the team's self-hosted history server (`history-server/` in the repo). CI runs uploaded with `upload` show up in `analyze-history` (`source: both`). Unset = no network calls. Old names `PW_MCP_PRO_KEY` / `PW_MCP_PRO_URL` still work |
| `PW_MCP_BLOCK_WRITES` | off | `1` makes the page tools abort POST, PUT, PATCH and DELETE requests that no mock or HAR answers (0.8.0+) |
| `PW_MCP_PYTHON` | project venv, then `python3` | The Python used for pytest-playwright projects (0.8.0+) |
| `PW_MCP_PROTOCOL` | both | `legacy` stops offering the 2026-07-28 MCP revision (0.8.0+) |
| `PW_MCP_SKILLS` | on | `0` stops serving this skill over the MCP Skills extension (0.8.0+) |
| `PW_MCP_NO_UPDATE_CHECK` | off | `1` stops `doctor` asking npm whether a newer version is out (0.8.0+) |
| `PW_MCP_HISTORY` | on | `0` stops recording runs to `<project>/.playwright-e2e-mcp/history.jsonl` (this turns off `analyze-history`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `PW_MCP_HTTP_TOKEN` | none | HTTP bridge only: bearer token that unlocks all tools |

## Hosted endpoint

Clients that only accept remote MCP servers can use the Streamable HTTP bridge
(`https://playwright-e2e-mcp.vercel.app/api/mcp`, or your own deployment of the
repo). Without a bearer token the bridge serves only `list-tests`,
`get-failure` and `analyze-history`, so the core loop in `SKILL.md` needs a local install or a token.

## Check it works

Ask the agent to "list my Playwright tests". It should call `list-tests` and
return files and titles. Clients that show MCP prompts also list
`/fix-failing-test` and `/triage-flaky-tests`. If it says the tools are missing, the server is not
connected: restart the client after editing its config.

## CI (0.3.0+)

The same diagnosis runs without an agent:

```bash
npx -y playwright-e2e-mcp ci --flaky-runs 3 --suggest 2 --output report.md
```

Exit code 0 means passed, 1 tests failed, 2 the run itself failed. On GitHub
Actions it also writes to the job summary. As an Action:

```yaml
- uses: xsignon-secure/E2E@v0.14.1
  with:
    flaky-runs: 3
    suggest: 2
```

It keeps one PR comment up to date when the run fails (needs
`pull-requests: write`).

From 0.7.0, `npx -y playwright-e2e-mcp guard --base origin/main` (or the
Action's `guard: true` input) fails the job when a changed test was made to
pass by checking less, and `ci` honours `playwright-quarantine.json`.
