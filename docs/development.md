# Development

[← README](../README.md) · [Tool reference](tools.md) · [Hosted endpoint](hosted-endpoint.md)

```
src/
├── index.ts            # bin entry point (--version/--help, main-module guard)
├── server.ts           # McpServer setup, tool registration, shutdown handling
├── tools/              # the twenty tools, the probe script + shared plumbing
├── prompts.ts          # fix-failing-test, triage-flaky-tests
├── utils/              # playwright-runner, report-parser, project-detector, path-utils,
│                       # logger, trace-reader (trace.zip → DOM/network/console),
│                       # image-diff (PNG codec + pixel diff), change-analyzer,
│                       # locator-expr, run-history, run-registry
└── types/              # shared interfaces and the ErrorKind taxonomy
```

Built on **`@modelcontextprotocol/server` v2** (the `2026-07-28` MCP spec line) with
Zod v4 standard schemas; every tool declares spec tool annotations.

```bash
npm install
npm run build   # tsc → dist/ (zero errors)
npm test        # build + test/run-tests.mjs (unit tests, any Node ≥22)
npm run coverage  # the same, with a line and branch coverage report
npm run e2e     # build + e2e/run.mjs: live MCP ↔ Playwright integration suite
npm run mcpb    # build + bundle dist/ into playwright-e2e-mcp-<version>.mcpb (+ .sha256)
npm run mcpb:smoke   # ...then install that bundle in a temp dir, launch it and assert the handshake
npm run mcpb:sign    # ...then sign it with MCPB_CERT/MCPB_KEY → <version>.signed.mcpb
npm run skill:zip    # just the archive: dist-skill/playwright-e2e-mcp.zip
npm run skill:package # the uploadable folder: ../agensi-skill-<version>/ (skill copy, README, zip)
npm run skill:check  # build, then fail if a packaged copy has drifted from skill/
```

Tests cover the report parser (sample Playwright JSON, trace attachments), path utils
(Windows and macOS paths, sandboxing), the project detector (temp-dir fixtures: config
discovery, multiple configs, missing install, test-file scanning), the shared tool
helpers, the **trace reader** (synthetic trace.zip: error, failed action, DOM snapshot,
`*.network` failed-request parsing, console error/warning events), the **image diff**
(PNG round-trip, regions, color shift, dimension changes), the **change analyzer**
(selector extraction, git + mtime paths), the **flaky verdict logic**
(failure signatures, CONSISTENTLY FAILING / FLAKY / NOT REPRODUCING / NO TESTS RAN,
per-test grouping of repeat attempts and the parallel-vs-alone reading), the `ci`
argument parser and tool profiles,
the **HTTP bridge** (token, restricted mode, Host allowlist), the **security
regressions** (sandbox escapes, argument smuggling, symlink writes, code injection,
SSRF ranges, env scrubbing, decode limits), the `.mcpb` manifest, the `.mcpb` zip
extractor, the **skill package** (byte-identical rebuilds, a CRLF checkout hashing the
same, refusal of junk/binary/symlinks, and drift detection between `skill/` and a
packaged copy), and the MCP config files.

## Integration suite (`npm run e2e`)

Unit tests prove the logic; the integration suite proves the loop. It boots the real
server over stdio against a live fixture app and a Playwright project under
`e2e/fixture/`, then drives it exactly like an MCP client and asserts ~40 behaviours
that only appear end-to-end:

- initialize handshake, 20 tools, 2 prompts, spec tool annotations and object input schemas,
- verified locators, locator validation, signed-in pages (`storageState`) and page steps,
- background runs with progress, run history views, and `suggest-fix` healing a drifted
  locator and an ambiguous one, verifying each with a re-run (and refusing when the
  element is missing),
- Web Vitals with budgets and phone throttling, and network mocks that force error and
  empty states,
- live DOM inspection, CSS selector validation (matches, zero matches, engine
  syntax, parse errors), dead-server detection,
- visual regression: baseline → unchanged compare → `blue → red` diff detection,
- `run-test` pass/fail/`lastFailed` stats and meta lines,
- `get-failure` trace diagnostics: DOM at failure, the 404 network request,
  the `console.error` message, diagnosis and next steps,
- auto-retry turning a first-run failure into `PASSED (1 flaky)`,
- `diagnose-flaky` verdict **FLAKY** (2 of 3 runs) with retries disabled, in one
  `--repeat-each` process, and `isolate` reading a shared-slot test as "fails only in parallel",
- `--tools=` profiles trimming `tools/list`, and the `ci` command's exit code, report,
  `--output` file and GitHub job summary,
- `generate-e2e-test` writing its scaffold, plus error paths
  (missing test path, unknown tool, unreachable server).

First run needs the browser once: `npx playwright install chromium`.
CI runs the suite on Ubuntu and Windows (see `.github/workflows/ci.yml`).

## Signing the bundle

```bash
MCPB_CERT=~/signing/cert.pem MCPB_KEY=~/signing/key.pem npm run mcpb:sign
```

Signing appends a PKCS#7 signature block to the bundle, so the signed file is
*the reproducible bundle plus that block*. That ordering is the point: the bytes
CI proved identical across platforms stay inside the signed file, and
`mcpb unsign` returns them exactly. `scripts/sign-mcpb.mjs` asserts that round
trip on every run and deletes its output if it fails, which is what keeps
`<version>.signed.mcpb` tied to `<version>.mcpb`.

The private key is read from a path you pass in (`--cert`/`--key` or
`MCPB_CERT`/`MCPB_KEY`) and never from the repository — keep it outside version
control, and back it up: the same key across releases is what makes the signer
recognisable.

What signing does and does not buy you is decided by the certificate, not by
this script. `mcpb verify` and `mcpb info` accept a signature only when the
certificate chains to something in the OS trust store, so with a self-signed
certificate a host still reports **Not signed** — the signature is real
integrity and key continuity, verifiable by the fingerprint the script prints,
but not third-party identity. A certificate issued by a public CA, or an
internal one installed on your machines, is what makes hosts report it as
signed.

## Assembling a release

```bash
npm run mcpb && npm pack                  # the bundle, then the npm tarball
npm run release:assemble -- --tag v0.2.3  # sign, checksum and write the notes
npm run release:publish -- --tag v0.2.3 --assets dist-release/assets \
  --title-file dist-release/RELEASE_TITLE.txt \
  --body-file dist-release/RELEASE_BODY.md --download dist-release/downloaded
npm run release:verify -- v0.2.3 --dir dist-release/downloaded
npm run release:publish -- --tag v0.2.3 --publish
```

Pushing a `v*` tag runs exactly that sequence in
`.github/workflows/release.yml`. The release used to be assembled by hand, and
the notes were written from what those commands printed: every hash in them was
a copy, and nothing compared the bundle hash printed there with the bundle that
shipped.

`scripts/assemble-release.mjs` stages the whole release into
`dist-release/assets/`: the bundle and its sidecar, the **signed** bundle and the
signing certificate when a key is configured, the npm tarball, the skill package
built by the same writer as `npm run skill:zip`, and `SHA256SUMS.txt` covering
every file it staged. It empties that directory first, so a file left over from
an earlier run cannot be hashed and published as if this run had produced it.

The notes are half written, half generated. `release-notes/<tag>.md` holds the
prose — its H1 becomes the release title and has to name the tag — and the script
appends the asset table, the reproduction recipe carrying the real bundle hash,
the signer and fingerprint, and the commit list. The prose is held to the same
rule: a 64-character hex string in it has to be a hash this release publishes,
and writing an `## Assets` section of your own fails the assembly rather than
shipping a second, staler table. See [release-notes/README.md](../release-notes/README.md).

`scripts/publish-release.mjs` fills the release **as a draft**, uploads the
assets, downloads every one of them back and compares it byte for byte, and only
`--publish` makes it public — after `release:verify` has re-derived the release
from the tag. Re-running is safe: a draft this workflow assembled is refreshed in
place, while a release it did not assemble, or one already published, is refused
by name instead of overwritten.

Signing is optional and its absence is stated rather than hidden: without the
`MCPB_KEY` and `MCPB_CERT` repository secrets the release is assembled and
published **unsigned**, with a notice in the run and a line saying so in the
notes. Add both — the private key stays out of the repository and out of the logs:

```bash
gh secret set MCPB_KEY  --repo xsignon-secure/E2E < ~/signing/key.pem
gh secret set MCPB_CERT --repo xsignon-secure/E2E < ~/signing/cert.pem
```

Creating the release and uploading its assets needs `contents: write`, which the
job requests for itself; if it is refused, the run names the setting to change.

## Verifying a published release

```bash
git checkout v0.14.0 && npm ci && npm run mcpb
npm run release:verify -- v0.14.0
```

The release notes promise that the tag rebuilds the published bundle byte for
byte. `scripts/verify-release.mjs` checks that promise from a checkout of the
tag: the published bundle against your fresh build, every checksum the release
publishes (and that nothing shippable is missing from `SHA256SUMS.txt`), a
**signed** bundle against the bytes its signature wraps, the **skill package**
against a rebuild from the same tag, and that the published archive still
extracts with that version's manifest. The skill package is required of a tag
whose tree carries the publishing workflow; older tags predate it, so there it
is checked when present and skipped when not, like the signing certificate.
`.github/workflows/verify-release.yml` runs it on demand for any past tag, and by
itself for a release published by hand. A release assembled by
`.github/workflows/release.yml` runs the same check on its own assets *before*
it is published — GitHub does not raise `release: published` for a release created
with the repository's own token, so the check is a step there rather than a
trigger. The `.tgz` is checked for download integrity only: npm
records the packer's line endings, so a tarball packed locally on another OS is
legitimately different.

## Packaging the agent skill

```bash
npm run skill:package                    # ../agensi-skill-<version>/, ready to upload
npm run skill:zip                        # only the archive: dist-skill/playwright-e2e-mcp.zip
npm run skill:check                      # build, then compare every copy
npm run skill:check -- ../agensi-skill-0.3.0
```

`skill/` is an [Agent Skill](https://agentskills.io/specification) — the
instructions an agent follows to drive this server — and the marketplace gets
the same Markdown as a zip with `playwright-e2e-mcp/` at its root.
`scripts/package-skill.mjs` produces that zip, so the uploaded copy is built
rather than assembled by hand, and it refuses what the marketplace rejects: a
missing `SKILL.md`, a non-text file, a symlink, `Thumbs.db`.

`skill:package` writes the whole folder a release would otherwise assemble by
hand — the skill copy, `skill/README.md` and the archive — to
`../agensi-skill-<version>` (or `--out <dir>`), then verifies it with the same
comparison `check` uses, so a successful exit means the folder really is the
skill tree. It is idempotent: a folder that already matches is left untouched.
A folder that has drifted is refused instead of overwritten, because it may
already be published — bump `version` for a new package, or pass `--force` to
replace that one.

The archive comes from the same deterministic writer as the `.mcpb`, so the
same tree always hashes the same, and text payloads are LF-normalised first:
a CRLF checkout builds the bytes an LF one does. CI runs `skill:check`, generates
a package folder, and uploads the built zip as an artifact
(`.github/workflows/ci.yml`).

**Every release publishes the package too.** Assembling a release builds it from
the release tag and attaches it as `<name>-<version>-skill.zip`, and the
`.github/workflows/release.yml` run downloads that asset back off the draft and
byte-compares it with the build before anything is published. The marketplace
upload is that asset, not a folder someone assembled — a deterministic archive
means "the same build as the tagged release" is an exact statement, and
`release:verify` checks it again against a rebuild from the tag.
`.github/workflows/publish-skill-package.yml` stays for the repair path: run it
by hand to attach or rebuild the package for a release that is missing it.

`skill:check` is the other half of that, and the part that matters when a
package has already been uploaded. It builds twice (the bytes must agree),
reads the archive back and compares its contents with `skill/` file by file,
then compares a packaged copy — `../agensi-skill-<version>` by default, or a
path you pass: the package folder, the bare `playwright-e2e-mcp/` folder, or
the zip on its own. Comparisons are by content, never by archive bytes, because
a zip written by a platform `zip` tool carries real timestamps that say nothing
about whether the Markdown inside it is current. Any file that differs, is
missing or is extra is named on stderr and the command exits 1 — the repository
copy and the uploaded copy are the same document, so an edit to either one
should not be invisible.

## Try the example

With Playwright installed in your project:

```bash
npx playwright test examples/sample-test.spec.ts
```

or ask your agent to call `run-test` with
`"testFiles": ["examples/sample-test.spec.ts"]` — it hits the public
[example.com](https://example.com) page, so it verifies browsers, network and the MCP
pipeline in one shot.

## Docker

Each release tag publishes the image to `ghcr.io/xsignon-secure/playwright-e2e-mcp`
(tags `<version>` and `latest`, by `.github/workflows/publish-docker.yml`):

```bash
docker run -i --rm -v "$PWD:/work" ghcr.io/xsignon-secure/playwright-e2e-mcp       # stdio MCP server
docker run --rm -v "$PWD:/work" ghcr.io/xsignon-secure/playwright-e2e-mcp ci       # CI report
docker build -t playwright-e2e-mcp .                                               # or build it yourself
```

The image is based on `mcr.microsoft.com/playwright:v1.64.1-noble`, so its
browsers match Playwright 1.64. Mount your project at `/work`; its own
`node_modules` provide `@playwright/test`.
