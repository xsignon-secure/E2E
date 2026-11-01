# Hosted endpoint (ChatGPT and remote clients)

[← README](../README.md) · [Tool reference](tools.md) · [Development](development.md)

Some clients — ChatGPT custom connectors especially — only accept **remote
HTTPS** MCP servers and refuse to spawn a local `npx` process. This repo ships a
Streamable HTTP bridge for exactly that case:

| | |
| --- | --- |
| **Endpoint** | `https://playwright-e2e-mcp.vercel.app/api/mcp` |
| **Transport** | MCP Streamable HTTP (`POST` JSON in, JSON or SSE out) |
| **Auth** | bearer token (`PW_MCP_HTTP_TOKEN`), or OAuth sign-in with that token as the access key (for claude.ai connectors). The deployment at this URL requires one of them; a bridge started without the variable serves only the read-only tools |
| **Source** | [`api/mcp.ts`](../api/mcp.ts) → [`src/http.ts`](../src/http.ts) |

The bridge runs the *same* `createServer()` as the stdio transport; the SDK
serves every request with a fresh server instance, which is what a serverless
function wants. `test/http-bridge.test.mjs` drives the real Node adapter over
`node:http` so a broken bridge fails in CI, not in ChatGPT.

**This demo deployment is token-protected.** `https://playwright-e2e-mcp.vercel.app`
runs on the maintainer's account and has `PW_MCP_HTTP_TOKEN` set, so a request
without `Authorization: Bearer <token>` (or an OAuth sign-in with it) gets
`401 {"error":"unauthorized"}`. Nothing is held back: the same bridge is free to
host yourself on a free Vercel account, with your own token:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxsignon-secure%2FE2E&env=PW_MCP_HTTP_TOKEN&envDescription=A%20random%20secret%20of%2016%2B%20characters%3B%20clients%20send%20it%20as%20a%20bearer%20token%20or%20type%20it%20to%20sign%20in&project-name=playwright-e2e-mcp)

The deployment bundles a serverless Chromium, so the page tools work from the web on public
URLs. Running and fixing your own tests needs your project next to the server, so for that the
free local install (`npx -y playwright-e2e-mcp init`) is the route.

**Open vs. token-protected.** With `PW_MCP_HTTP_TOKEN` set (at least 16
characters, 32 or more recommended; use a random value such as
`openssl rand -base64 32`) every tool is served to clients that send
`Authorization: Bearer <token>`, and every other request gets `401`. Without that
variable anyone who reaches the URL can call the bridge, so it degrades to
`list-tests`, `get-failure` and `analyze-history` in restricted mode: `list-tests` scans sources
instead of running `playwright test --list` (which would execute the project's
config), callers cannot pick another `projectRoot`, and nothing spawns a process,
drives a browser or writes a file. Child processes started over HTTP get only an
allowlisted environment. `PW_MCP_ALLOWED_HOSTS` (comma separated, `*` for any)
limits the accepted `Host` header; without a token and without that variable,
only `localhost` names and the deployment's own Vercel hostnames are accepted
(DNS-rebinding protection).

**Add it to ChatGPT:** Settings → Connectors → turn on **Advanced → Developer
mode** → *Create custom connector* → paste the endpoint above. Authentication
**None** only works against a bridge with no token (read-only tools), so for this
deployment choose the connector's **API key** authentication and send
`Authorization: Bearer <token>` — or point the connector at your own deployment
with `PW_MCP_HTTP_TOKEN` unset.

**Add it to claude.ai (or Claude Desktop's connectors):** Settings → Connectors →
*Add custom connector* → paste the endpoint above and leave the OAuth fields
empty. Claude registers itself and opens a sign-in page; type the deployment's
access key (the value of `PW_MCP_HTTP_TOKEN`) and press **Allow access**. The
bridge is its own small OAuth 2.1 server (discovery, dynamic client
registration, authorization code with PKCE S256, refresh tokens) and keeps no
state: client ids, codes and tokens are signed with a key derived from
`PW_MCP_HTTP_TOKEN`, access tokens last an hour and refresh tokens 30 days, and
changing `PW_MCP_HTTP_TOKEN` signs every connected client out. The sign-in page
shows which site will receive access, so only type the key when that is the
app you are connecting.

**Limits on guessing.** After 20 wrong tokens or access keys from one address
within 15 minutes (`PW_MCP_MAX_FAILED_AUTH`), that address gets `429` until the
oldest failure is 15 minutes old. Each warm serverless instance counts on its
own, so for a public deployment also add a rate-limit rule for `/oauth/authorize`
and `/api/mcp` in the Vercel Firewall. To accept only known apps, set
`PW_MCP_OAUTH_REDIRECT_HOSTS` (for example `claude.ai,chatgpt.com`); registration
then refuses any app that returns users elsewhere.

**Signing clients out.** Sign-ins carry no server-side state, so one client
cannot be signed out on its own: changing `PW_MCP_HTTP_TOKEN` signs out every
client, and each signs in again with the new key. Source: [`src/oauth.ts`](../src/oauth.ts); the
`/.well-known/oauth-*` and `/oauth/*` paths reach the function through the
rewrites in [`vercel.json`](../vercel.json).

To self-host the open, read-only variant, deploy this repo with
`PW_MCP_HTTP_TOKEN` unset; nothing else changes.

Codex can also take the remote transport instead of spawning `npx`, if you'd
rather not ship Playwright to every machine. Point it at the token through an
environment variable so the secret stays out of the config file:

```bash
export PW_MCP_HTTP_TOKEN=…   # ask the operator for the value
codex mcp add playwright-e2e-remote --url https://playwright-e2e-mcp.vercel.app/api/mcp \
  --bearer-token-env-var PW_MCP_HTTP_TOKEN
```

**What to expect:** with a token, the page tools run on Vercel:

| Works on the hosted endpoint | Needs the local install |
| --- | --- |
| `inspect-page`, `validate-selector`, `audit-accessibility`, `audit-performance` on public URLs (Chromium only; private and loopback addresses are refused) | `run-test`, `diagnose-flaky`, `suggest-fix`, `generate-e2e-test` and `load-report` need your project; `compare-visual-state` needs somewhere to keep baselines |
| `list-tests` and `get-failure` (a self-hosted bridge without a token serves these and `analyze-history`) | Firefox and WebKit, and pages on `localhost` or your private network |

The browser is [`@sparticuz/chromium`](https://github.com/Sparticuz/chromium), a Chromium
build for serverless functions, driven by the bundled `playwright-core`. The first call on a
cold function unpacks it (about 2 seconds). Tools that need a project return a note that points
to the local install. Set `PW_MCP_SERVERLESS_CHROMIUM=0` in the Vercel project to turn the
browser off.

```bash
# verify the handshake without any client (the live deployment needs the token;
# drop the authorization header and it answers 401 instead)
curl -X POST https://playwright-e2e-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $PW_MCP_HTTP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

## Discovery: Server Card and AI Catalog

The endpoint publishes an [MCP Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards)
at `/api/mcp/server-card` and an AI Catalog that links to it at `/.well-known/ai-catalog.json`.
Registries, IDEs and agents read them to learn the name, version, icon, transport and protocol
versions before they connect. Both are public (no token), carry no secrets and list no tools; when
the deployment has a token, the card says an `Authorization` header is required.

```bash
curl -H 'accept: application/mcp-server-card+json' https://playwright-e2e-mcp.vercel.app/api/mcp/server-card
curl https://playwright-e2e-mcp.vercel.app/.well-known/ai-catalog.json
```

The bridge speaks both the stateless 2026-07-28 MCP revision (clients that call
`server/discover` first) and the 2025 `initialize` handshake on the same URL.

Redeploy after a change: merge to `main`. Vercel's Git integration deploys
every push, so there is no token to manage and no CLI step — watch the
`Vercel` commit status for the deployment result.
