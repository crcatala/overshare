# Development

## Setup

Node.js 22.19 or newer.

```bash
git clone https://github.com/crcatala/overshare.git
cd overshare
npm install
npm run build
npm link            # optional: puts this checkout's `overshare` and `ovs` on PATH
```

```bash
npm test                         # vitest (reads viewer/dist, so build first)
npm run typecheck                # CLI, viewer, landing page and build config
npm run build                    # dist/ (CLI) + viewer/dist/ (Vite)
npm run dev                      # viewer dev server with HMR and the fixture sessions
npm start -- report --current    # run the CLI from source via tsx
npm run verify                   # everything CI and a release run: typecheck, build, tests, package smoke test
npm run test:package             # pack the npm tarball, install it, and run the installed CLI end to end
```

Fixtures are generated in code and fake secrets are assembled at runtime, so the test suite never
holds a real-looking credential in a source file.

## How it fits together

Transcripts are normalized into one harness-agnostic format (`overshare/1`), projected to a share
mode, redacted, re-scanned, and only then uploaded as a public-by-link file.

```
harnesses/           pipeline                                   publish/            viewer/ (static)
 claude-code/   ─┐   parse → stats → project(mode) → redact     gist                #owner/gistId
 pi/            ─┴─► NormalizedSession ─────────► re-scan ────► public R2 ─────────► #r2:<id>
```

| Path | What lives there |
| --- | --- |
| `src/cli.ts` | command definitions (commander) |
| `src/harnesses/` | one folder per agent: transcript parsing, summaries, usage (see [Adding a harness](#adding-a-harness)) |
| `src/pipeline.ts`, `src/modes.ts` | normalize → project to a share mode → redact → re-scan |
| `src/redact/` | every redaction layer and the final re-scan ([Redaction](redaction.md)) |
| `src/publish/` | gist and R2 targets |
| `src/browse/` | the `overshare browse` terminal UI |
| `src/schema.ts` | the share format and its version |
| `viewer/` | the static web viewer (Vite, framework-free) |
| `site/` | the landing page at `/` |
| `integrations/` | Claude Code skill and pi extension |
| `tests/` | vitest suites; `tests/fixtures/` holds sanitized real sessions and frozen shares |

## Fake sessions for testing

`overshare fixtures` (or `npm run fixtures`) writes realistic, deterministic Claude
Code and pi transcripts — plus redacted shares in every mode — that exercise the whole
viewer (thinking, all tool kinds, errors, diffs, images, subagents, slash commands,
skills, interrupts, API errors, compaction, model changes, rewinds/branches, queued
prompts, a truncated build log) and every redaction layer (an `env` dump, `.env`, keys
in each detector's format, a PEM key, a JWT, and a format-less token that only
`--secrets-file` catches). Planted credentials are random fakes.

Quickest way to look at the viewer locally — generates the fixtures, exports shares in
every mode, and serves them (nothing is uploaded):

```bash
npm run demo          # or: overshare demo [--seed 2] [--turns 30] [--port 3000]
# All sessions: http://localhost:3000/s/   ← picker listing every local share
```

Opening the viewer without a share in the link shows that picker whenever it is served
by `overshare serve`/`demo` (it reads `./local/index.json`; deployed viewers have none).

```bash
overshare fixtures --out fixtures-out --seed 1 [--turns 30]
overshare serve fixtures-out/shares/*.json                       # browse them
overshare report fixtures-out/claude/projects/*/*.jsonl --mode full --secrets-file fixtures-out/secrets.env
OVERSHARE_CLAUDE_PROJECTS=fixtures-out/claude/projects overshare list
```

Transcripts use your home directory and username by default (so home-path redaction
applies); pass `--home`/`--user` to change them.

## Developing the viewer

```bash
npm run dev     # Vite dev server → http://localhost:3000/s/
```

- **Variants:** `viewer/src/styles/<variant>.css` (scoped by `html[data-variant]`) over
  `base.css`; `viewer/src/variants.ts` lists them. Point the dev server at longer sessions
  to judge them: `overshare fixtures --out /tmp/big --turns 120` then
  `OVERSHARE_DEV_SHARES="/tmp/big/shares/claude-code-full.json" npm run dev`.
- **HMR:** CSS edits hot-swap in place; TypeScript edits reload the page (the viewer is
  framework-free), which keeps the open session because it lives in the URL hash.
- **Data:** the fixture sessions are served at `/s/local/` (generated into
  `fixtures-out/` on first run), so the picker lists them immediately. Point it at other
  exports with `OVERSHARE_DEV_SHARES="a.json b.json" npm run dev`.
- **CSP:** dev only allows inline styles and the HMR WebSocket; builds keep the strict
  policy.
- **File access:** Vite may only read `viewer/`, `src/` and the bundled prose font's
  package (`server.fs.allow`), so the any-hostname setting cannot be used to read other
  files in the checkout (raw transcripts, a secrets file) via `/@fs/`.
- **Network:** listens on localhost only; `npm run dev -- --host` exposes it on all
  interfaces. Any hostname is accepted (VPS domain, Tailscale name, tunnel).
- `npm run preview:cf` builds and runs the viewer in Cloudflare's local runtime
  (`wrangler dev`) to check `_headers`/`_redirects` exactly as deployed.

## Adding a harness

Everything that is specific to one harness lives in `src/harnesses/<name>/`; the rest of the
code asks the registry (`src/harnesses/index.ts`) and never switches on a harness name.

```
src/harnesses/
  meta.ts          plain data per harness: label, tag, colour, search aliases, a few viewer flags
                   (browser-safe: the viewer imports it). `HarnessName` is derived from it.
  index.ts         HARNESSES: Record<HarnessName, Harness>, plus detect / parse helpers
  types.ts         the `Harness` descriptor: what a harness folder has to provide
  shared.ts        TurnBuilder, describeTool, ... for writing an adapter
  summary-kit.ts   Collector, for the browser's one-pass index
  claude-code/     parse.ts, usage.ts, summarize.ts, subagent-files.ts, index.ts (the descriptor)
  pi/              parse.ts, summarize.ts, index.ts
```

1. Add an entry for it in `src/harnesses/meta.ts`. `npm run typecheck` now fails in
   `index.ts`, because `HARNESSES` has no descriptor for the new name.
2. Make `src/harnesses/<name>/` and write its descriptor (`index.ts`, see `pi/index.ts` for
   the short one): where its sessions live (`sessionsRoot`, `listFiles`, `sessionId`), how to
   recognise a transcript (`detect`), `parse` (native transcript → `NormalizedSession`, with
   `TurnBuilder`) and `summarize` (feed lines to a `Collector`). Optional members cover what
   only some harnesses have: `currentSession` (a session id in the environment),
   `subagents` (transcripts in files beside the session), `credentialFiles` (its login files,
   so a leaked value is redacted).
3. Register it in `HARNESSES`.

That is all: `list`, `browse` (filter, dialog, tag, preview), `--harness`, `harness:<alias>`
searches, `--current`, the viewer's label and the "supported formats" error all read the
registry and meta. Also worth adding: a fake-session generator in `src/fixtures/` (see
`pi.ts`) and tests. Share files keep `harness.name`, so a new name is not a schema change.

## Changing the share format

Additive changes (a new optional field) need nothing special. An incompatible change needs a
schema version bump, a viewer migration and a frozen share; the steps are in
[`tests/fixtures/shares/README.md`](../tests/fixtures/shares/README.md).

## Maintenance scripts

- `npm run update:prices` regenerates `src/pricing-data.ts`, the model price table behind the
  viewer's estimated cost.
- `npm run audit:usage` checks the usage and cost overshare computes against the sessions on your
  machine (Claude Code's own `cost-state` totals, pi's raw usage entries). Not run in CI.
- Releases: see [RELEASING.md](../RELEASING.md).
