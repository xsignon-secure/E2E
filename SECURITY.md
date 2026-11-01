# Security policy

## Supported versions

Security fixes go into the latest release on npm (`playwright-e2e-mcp`). Please upgrade
before reporting.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
[Report a vulnerability](https://github.com/xsignon-secure/E2E/security/advisories/new).

Include what an attacker can do, the steps or a proof of concept, and the version and
transport (stdio or the HTTP bridge). We aim to acknowledge reports within 3 working days
and to ship a fix or mitigation within 30 days for confirmed issues, and will credit you in
the release notes unless you prefer otherwise.

## Scope

In scope: path sandbox escapes, command or argument injection into Playwright or git,
SSRF past the URL guard, the HTTP bridge's auth and environment isolation, and anything
that lets a tool caller read or write outside the project root.

Out of scope: test code you run yourself (it runs with your permissions by design), and
issues in Playwright or the MCP SDK themselves (report those upstream).

## How the server protects you

- **No shell**: Playwright is spawned as `node <playwright/cli.js> …` with an argument
  array — no command interpolation. Extra `args` are limited to an allowlist of
  Playwright flags, each with a checked value (`--flag=value`), so a caller cannot
  swap in another `--config` or `--output` or hand git an option through
  `--only-changed`. Paths with a segment starting with `-` are rejected, so a test
  file name cannot be read as a flag.
- **Path sandbox**: user paths must stay inside the project root, checked lexically
  and again with symlinks resolved. A caller-supplied `projectRoot` must sit inside
  `PW_MCP_PROJECT_ROOT` (or a `PW_MCP_ALLOWED_ROOTS` entry).
- **Generated code**: `generate-e2e-test` only writes `*.spec.*` / `*.test.*` files,
  only overwrites specs whose header it wrote itself, never writes through a symlink,
  and escapes every value it puts into strings or comments.
- **HTTP bridge**: read-only tools unless `PW_MCP_HTTP_TOKEN` is set; child processes
  started over HTTP get only an allowlisted environment (`PATH`, `HOME`, temp dirs,
  locale, `CI`, `PLAYWRIGHT_*`, `npm_config_*` without embedded credentials, plus
  anything in `PW_MCP_PASSTHROUGH_ENV`), at most `PW_MCP_MAX_CHILDREN` run at once
  (a disconnected client frees its slot immediately), and internal error messages
  are not returned to clients. Wrong tokens and access keys are limited per client
  address (`PW_MCP_MAX_FAILED_AUTH`, 20 per 15 minutes), and
  `PW_MCP_OAUTH_REDIRECT_HOSTS` can restrict which apps may sign in. Client ID
  Metadata Documents are fetched over https only, without redirects, never from a
  private or reserved address, with a 5 second timeout and a 16 KB cap. The allowlist only covers the child's own
  environment: test code runs as the same OS user, so on Linux it could still read
  the server's startup environment from `/proc`. That is why only token holders
  can run project code; keep other secrets out of the bridge's environment, or run
  it under a separate user.
- **SSRF guard**: on the HTTP bridge (or with `PW_MCP_BLOCK_PRIVATE_URLS=1`) the URL tools
  refuse hosts that resolve to loopback, private, link-local/metadata or reserved
  addresses, and route the browser through a local proxy that applies the same check
  to every redirect hop and subresource; IPv6 forms that embed an IPv4 address
  (mapped, NAT64, 6to4, Teredo) are blocked too, and WebRTC UDP is disabled so a
  page cannot reach the network around the proxy. It is off for stdio by default because
  opening `http://localhost` dev servers is what these tools are for.
- **Cleanup**: temp report/script files are written to the OS temp dir and removed;
  child processes are tracked and killed on shutdown. Trace decompression has one
  size budget per archive, and PNGs are capped at 16,384 px per side and 50 M pixels.
