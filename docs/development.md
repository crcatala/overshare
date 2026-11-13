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

`tests/redact-properties.vitest.ts` holds property-based tests ([fast-check](https://fast-check.dev)) for
redaction: invariants checked on generated input rather than hand-picked examples. Each runs 100
cases in `npm test`; search longer locally with
`FC_NUM_RUNS=20000 npx vitest run tests/redact-properties.vitest.ts --testTimeout=0`. A failure prints its seed and a
shrunk counterexample; pin what it found as an example test.

`npm run audit:redaction -- --base main` shows what a change to redaction does to the sessions on your
machine. It runs `prepareShare` in brief and full mode over every local Claude Code and pi session, once with
the base ref's `src/` (checked out in a temporary git worktree) and once with the working tree's. Per mode it
prints status changes, finding deltas by rule and redaction deltas by category (home paths, emails, the
username and the hostname are only counted, never named by rule), each with the number of sessions, how many
sessions the final re-scan blocks on other rules or leaves other suspicious values in, errors, and the time
with any session that got much slower. Then the sessions where any of that changed, by file. No known values
are read (env, `.env`), and nothing it prints or saves holds a value or the text around one: statuses, rule
and category names, counts, times and file paths only.

```bash
npm run audit:redaction -- --base main                    # every session; takes a while
npm run audit:redaction -- --base main --limit 50         # the 50 newest
npm run audit:redaction -- --base main --mode full        # one mode
npm run audit:redaction -- --base main --shape changed    # also describe what's new in each changed session
npm run audit:redaction -- --from out/audit-redaction     # compare the saved results again, without rerunning
```

Each side's results are saved as JSON in `out/audit-redaction/` (`--out` to change it). `--shape <file>`
(repeatable, or `changed`) lists each pattern match the working tree finds in that transcript and the base
does not, by shape only: rule, length, lines, character classes, entropy, escaped quotes, a leading
placeholder word, and the key it was assigned to when that is a known secret-key word (`password`, or
`…_api_key` for a longer name ending in one; what precedes a match can be a URL's user or part of a value,
so it is never printed as found). That is enough to tell a real credential from a false positive without
printing it. Each session is read up to its size when the audit started, without a last line that isn't
complete JSON, so the one being written meanwhile is compared on the same text on both sides; sessions that
changed on disk are labelled `(live)`. Not run in
CI: it needs your own sessions. Run it for every change to detection, and put its summary (counts, never
session names) in the PR. The base runs with this checkout's `node_modules`: when a change removes a
dependency the base still imports, install it for the run with `npm install --no-save <package>`, and
`npm prune` afterwards.

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
  package (`server.fs.allow`), so whoever can reach the dev server cannot read other files
  in the checkout (raw transcripts, a secrets file) via `/@fs/`.
- **Network:** listens on localhost only; `npm run dev -- --host` exposes it on all
  interfaces. Vite's host check (DNS-rebinding protection) stays on: requests must be
  addressed to `localhost` or an IP address. To use another name (VPS domain, Tailscale
  name, tunnel), list it in `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` (comma-separated; a
  leading dot allows subdomains), set in your shell since Vite doesn't read it from `.env`:
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=my-box,.example.ts.net npm run dev -- --host`.
  The dev server is still unauthenticated, so keep real shares out of
  `OVERSHARE_DEV_SHARES` when exposing it and use `overshare serve` for those.
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

## Betterleaks rules

`vendor/betterleaks/` holds [Betterleaks](https://github.com/betterleaks/betterleaks)' rule file, copied
unchanged from a pinned release (`upstream.json`: tag, commit, sha256), with its MIT license, which the
converter also writes into the JSON it makes (the JSON is what ships in the package).
`npm run update:betterleaks` converts it into `src/redact/betterleaks-rules.json`, one rule per line, and
prints what it skipped and which rules lost part of their filtering. `src/redact/betterleaks.ts` detects with the
high-confidence rules that `src/redact/betterleaks-enabled.json` enables.

- **Shapes only.** Each rule keeps its id, regex, flags, lowercased keywords, value group, confidence,
  specificity and an entropy threshold. A rule's `validate`, `analyze` and `revoke` steps (which send a found
  secret to the provider's API) are never converted; a test checks that none reaches the JSON.
- **Regexes** are written for Go's engine and rewritten for JavaScript on Node 22, which has no `(?i:…)`:
  case-insensitivity that covers only part of a pattern is spelled out letter by letter (`[a-z]` →
  `[a-zA-Z]`), and syntax JavaScript reads differently is given Go's meaning (`.`, `\s`, `\z`,
  `[[:alnum:]]`, multi-line `^` and `$`, a `]` first in a class). A rule that can't be rewritten faithfully is
  skipped with the reason. Two small differences remain, both outside ASCII: JavaScript counts a character
  outside the Basic Multilingual Plane (an emoji) as two in a repeat count, Go as one, and Go's
  case-insensitive matching also folds a few non-ASCII letters (the Kelvin sign as `k`).
- **Filters** are written in Betterleaks' expression language and aren't ported, except an entropy
  threshold: a filter discards a finding when any of its `||` clauses holds, so its entropy clause can be
  kept alone. What else a rule loses (`tokenRatio`, `matchesAny`, a required component) is listed under
  its `dropped`.
- Rules scoped to file paths (`.php`, `.tf`…) are skipped, since a transcript has none. Rules Betterleaks
  reports only as part of another (`skipReport`) are kept, marked `componentOnly`.
- **Which rules detect** is decided by hand in `betterleaks-enabled.json`: every high-confidence rule is under
  `enabled` or under `excluded` with the reason (an identifier rather than a secret, a rule that is generic
  without the component Betterleaks pairs it with, one our own rules cover better, one that backtracks). A
  release that brings a new high-confidence rule leaves it off: `update:betterleaks` lists it as not yet
  decided and `tests/betterleaks.vitest.ts` fails until it is added to one of the two. Medium- and
  low-confidence rules aren't used.
- **Hand-written formats** (`src/redact/token-formats.ts`) overlap Betterleaks' rules for most providers. An
  entry stays while it finds a token that no Betterleaks rule matches exactly, which
  `tests/token-formats.vitest.ts` checks for each one on its test cases: lengthened, placed before `)`, `,`,
  `.` and `&`, and glued to a placeholder run (a rule that takes the run in has its match dropped as
  obviously fake). After a sync that makes an entry redundant that test fails; check the entry's cases
  through `findSecretPatterns` without it before removing it.
- **What is redacted** is the rule's value group. Where a rule names none, Betterleaks reports its first
  group that matched; overshare uses group 1 only when it holds every other group, and otherwise redacts the
  whole match, since in a few rules (`jwt-base64`, `microsoft-teams-webhook`) the first group is only a piece
  of the token.
- **Backtracking.** The rules were written for Go's regex engine, which runs in linear time; JavaScript's
  backtracks. `tests/betterleaks-backtracking.vitest.ts` times every enabled rule on long adversarial strings
  built from its own keywords and character classes, and fails a rule over budget. The timing runs in a child
  process killed after a timeout, so a rule that never returns fails the test, named, rather than hanging it.
  It found three: Go's any-character idiom `(?:.|[\n\r])`, which the converter now writes as `[\s\S]`, two
  adjacent repeats of one class (`alibaba-sts-security-token`), which it merges into one, and
  `curl-auth-header`, which is excluded. Strings built that way don't reach a slow part behind a prefix that
  must match first, so the test also checks each regex for the shape that made `temporal-cloud-api-key.1`
  take close to a minute (excluded too): two overlapping unbounded runs around a literal both match. Run it
  after a sync.

```bash
npm run update:betterleaks                 # rewrite the JSON from the vendored file and print the summary
npm run update:betterleaks -- --check      # fail unless the JSON matches the vendored file (CI runs this)
```

Never edit either file by hand: the converter checks the rule file's sha256 against `upstream.json`, and
CI checks that the JSON is what the converter makes of it.

To sync with a new Betterleaks release, follow [Maintaining the Betterleaks rules](maintaining-rules.md).

## Maintenance scripts

- `npm run update:prices` regenerates `src/pricing-data.ts`, the model price table behind the
  viewer's estimated cost (see [Price table](#price-table)).
- `npm run audit:usage` checks the usage and cost overshare computes against the sessions on your
  machine (Claude Code's own `cost-state` totals, pi's raw usage entries). Not run in CI. It first
  checks the committed price table against models.dev, so it never quietly measures a stale table:
  - a stale table is a warning naming the models that changed and the fix (`npm run update:prices`);
    the audit still runs, on the committed table;
  - offline (or if the check fails), a warning, and the audit still runs;
  - `--refresh` regenerates the table first (it rewrites `src/pricing-data.ts`, nothing else);
  - a model in your local sessions with no price fails the audit, naming the model and its call
    count (fix: `npm run update:prices`, or `SUPPLEMENTAL_PRICES` in `src/pricing.ts` for a model
    models.dev does not list); `--allow-unpriced` turns that into a warning.

  It never checks or upgrades your installed pi or Claude Code: the audit reads sessions already on
  disk, so their versions don't change the result.
- `npm run update:betterleaks` converts the vendored Betterleaks rule file into a rule table (see
  [Betterleaks rules](#betterleaks-rules)).
- `npm run audit:redaction -- --base main` compares redaction between a ref and the working tree over the
  sessions on your machine (see [Setup](#setup)). Not run in CI.
- Releases: see [RELEASING.md](../RELEASING.md).

## Price table

Claude Code transcripts record tokens, not cost, so overshare prices Claude calls from
`src/pricing-data.ts`, generated by `scripts/update-prices.ts`:

- **Source:** [models.dev](https://models.dev) (`https://models.dev/api.json`, `anthropic.models`):
  every `claude-*` model with a price, in USD per million tokens. Long-context tiers come along
  (`tiers`, from models.dev's `type: "context"` tiers; any other tier type stops the generator):
  `src/pricing.ts` bills the whole call at a tier's rates once its prompt is above the tier's size.
  The header names the snapshot date (the newest `last_updated` of the models kept), so an unchanged
  source regenerates the same bytes.
- **Cross-check:** LiteLLM's `model_prices_and_context_window.json` (BerriAI/litellm, `main`). Base
  rates, tier rates and the 1-hour cache write (2x input) are compared and every disagreement is
  printed, along with models only one source lists. A disagreement never fails the run: both sources
  are community-kept and either can lag, so a person decides.
- **Hand-kept:** `SUPPLEMENTAL_PRICES` in `src/pricing.ts`, for older models neither source lists.
  The generator refuses to write an id that would shadow one of them with different prices.
- `tests/pricing.vitest.ts` pins the prices confirmed against Claude Code's own `cost-state`
  (Opus 5.5 at both cache-write lifetimes, Haiku 4.5, Haiku 5.5's tiers), as a guard against a typo
  in the source; update them there on purpose when Anthropic changes them.

Nothing else is needed (no pi or Claude Code install), only network access:

```bash
npm run update:prices                          # fetch both sources and rewrite the table
npm run update:prices -- --check               # exit 1 if the committed table differs from models.dev
npm run update:prices -- --json summary.json   # also write added/changed/removed models and disagreements as JSON
npm run update:prices -- --from api.json --litellm litellm.json   # use saved copies instead of fetching
npm run update:prices -- --no-cross-check      # skip LiteLLM
```

Exit codes: 0 done (or up to date with `--check`), 1 `--check` found a difference, 2 the generator
failed (a schema change, an unknown tier type, a shadowed hand-kept price), 3 models.dev could not be
fetched. A failed LiteLLM fetch is reported and skipped.

### Price table bot

`.github/workflows/update-prices.yml` keeps the table current without anyone remembering to. It runs
on Mondays and Thursdays (06:17 UTC) and on demand, and keeps **exactly one PR** open, titled
`chore(prices): update model price table`, from the branch `bot/update-prices` (`scripts/price-bot.sh`):

- The source differs from the committed table: it regenerates the table, runs typecheck, build and
  tests, force-pushes `bot/update-prices` and opens the PR or updates the open one. The body lists
  added, changed and removed models, the LiteLLM disagreements, the snapshot date and how to verify.
  If typecheck or tests fail with the new table, the PR is still opened, marked failing at the top.
- The source matches the committed table (it reverted, or the PR was merged): it closes the open PR
  and deletes the branch.
- The generator fails (an unknown tier type, a schema change, a shadowed hand-kept price, the token
  being rejected, or models.dev unreachable on two runs in a row): it opens one issue titled *Price
  table update is failing* (label `prices`), or comments on the open one.
- There is one branch, so one PR: while `bot/update-prices` backs an open PR against one branch, a
  run on another branch fails (and reports in the issue) instead of repointing it.

`tests/price-bot.vitest.ts` runs the script against a local repository and a stub `gh`.

Run it by hand from the Actions tab (*Update prices*, *Run workflow*) or with:

```bash
gh workflow run update-prices.yml              # against main
gh workflow run update-prices.yml --ref <branch>   # the PR targets the branch it ran on
```

**Token.** A PR opened with the workflow's own `GITHUB_TOKEN` would not trigger CI, so the bot pushes
and opens the PR with the repo secret `PRICES_BOT_TOKEN`: a fine-grained personal access token
scoped to this repository only, with Contents, Pull requests and Issues read and write. Its PRs show
the token owner as author. The workflow's `GITHUB_TOKEN` only reads, files the failure issue and
reads run history (`contents: read`, `issues: write`, `actions: read`).

The current token **expires on 2027-11-13**; renew it about a week before. Create a new fine-grained
token with the same scope (longest expiry allowed), store it with
`gh secret set PRICES_BOT_TOKEN -R crcatala/overshare`, update the date here, and run the workflow by
hand to check it. An expired or revoked token fails the run with "PRICES_BOT_TOKEN expired or
invalid: renew it" and opens the same issue.
