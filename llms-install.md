# Installing playwright-e2e-mcp (instructions for AI agents)

You are an AI agent asked to install **playwright-e2e-mcp**, an MCP server that runs,
diagnoses and fixes failing Playwright tests, and its agent skill. Follow these steps in
order. Every step is safe to repeat.

## 1. Check the prerequisites

- Node.js 22 or newer: `node --version`.
- The project uses Playwright Test. If `@playwright/test` is not in `package.json`, ask the
  user before adding it (`npm install -D @playwright/test`). A Python project that uses
  `pytest-playwright` works too (0.8.0+): it needs `pip install pytest-playwright` and
  `playwright install chromium` in its Python environment instead.
- A browser for Playwright: `npx playwright install chromium`.

## 2. Install the server and the skill

Run this from the project root:

```bash
npx -y playwright-e2e-mcp init
```

It detects which clients the project uses (`.claude/`, `.cursor/`, `.vscode/`, `.gemini/`,
`.codex/`) and merges a `playwright-e2e` server entry into each one's project config,
keeping every other server. It also copies the skill into `.agents/skills/` and, for
Claude Code, `.claude/skills/`. Add `--dry-run` to see the changes first.

To pick the clients yourself, pass `--client`: `claude`, `cursor`, `vscode`, `gemini`,
`codex`, `windsurf` (user-level file) or `all`:

```bash
npx -y playwright-e2e-mcp init --client cursor,vscode
```

Use `--tools=core` to expose only the six tools of the fix loop (smaller tool context).

### Client-native alternatives

Use these when the user prefers their client's own installer:

| Client | Command |
| --- | --- |
| Claude Code (server + skill, as a plugin) | `/plugin marketplace add xsignon-secure/E2E` then `/plugin install playwright-e2e-mcp@xsignon-secure` |
| Claude Code (server only) | `claude mcp add playwright-e2e -- npx -y playwright-e2e-mcp` |
| Gemini CLI (server + skill, as an extension) | `gemini extensions install https://github.com/xsignon-secure/E2E` |
| VS Code | `code --add-mcp '{"name":"playwright-e2e","command":"npx","args":["-y","playwright-e2e-mcp"]}'` |
| Codex CLI | `codex mcp add playwright-e2e -- npx -y playwright-e2e-mcp` |
| Skill only, any agent | `npx skills add xsignon-secure/E2E` |
| Claude Desktop | download the `.mcpb` file from the latest GitHub release and open it |

For any other MCP client, add this server to its config:

```json
{
  "mcpServers": {
    "playwright-e2e": { "command": "npx", "args": ["-y", "playwright-e2e-mcp"] }
  }
}
```

## 3. Verify

1. Run `npx -y playwright-e2e-mcp doctor` in the project root. It checks Node, the
   Playwright config and install, the browsers, the test files and the client setup,
   and prints the command that fixes anything marked ✗. Fix those first. It also says
   when a newer version of the server is out.
2. Tell the user to restart or reload their agent so it loads the new server.
3. After the reload, call the `list-tests` tool (or `run-test`) with the project root. A
   result listing the tests means the install worked.
4. If the tool reports `NO_PLAYWRIGHT`, install `@playwright/test` and the browser
   (step 1) and try again.

## Configuration (optional)

Environment variables, set in the server entry's `env`:

- `PW_MCP_PROJECT_ROOT`: default project root (default: the client's working directory).
- `PW_MCP_TOOLS`: limit the exposed tools, for example `core`.
- `PW_MCP_ALLOWED_ROOTS`: extra directories callers may pass as `projectRoot`.
- `PW_MCP_PYTHON`: the Python to use for a pytest-playwright project (default: the
  project's `.venv`, `venv` or `env`, then `python3`).
- `PW_MCP_BLOCK_WRITES`: `1` makes the page tools abort POST, PUT, PATCH and DELETE requests.

## Updating

With the `npx -y playwright-e2e-mcp` setup, a restart of the client picks up the newest
release. For a project install run `npm install -D playwright-e2e-mcp@latest`; to refresh
the copied skill, run `npx -y playwright-e2e-mcp init` again.

No API keys or accounts are needed.

More detail: https://github.com/xsignon-secure/E2E#readme
