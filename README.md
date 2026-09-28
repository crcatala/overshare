# agent-share

Share coding-agent sessions (Claude Code, pi) as **redacted, unlisted links** with a
static viewer. Transcripts are normalized into one harness-agnostic format
(`agentshare/1`), redacted locally, projected to a share mode, re-scanned, and only
then uploaded as a public-by-link file (a secret GitHub gist or a public R2 bucket).

```
adapters/            pipeline                                   publish/            viewer/ (static)
 claude-code.ts ─┐   parse → stats → project(mode) → redact     gist                #owner/gistId
 pi.ts          ─┴─► NormalizedSession ─────────► re-scan ────► public R2 ─────────► #r2:<id>
```

Everything is static: the CLI redacts and uploads a public share file, and the viewer
is a plain static page that reads it. There is no backend and no auth — fork it, tweak
it, and deploy your own viewer if you want to own the code you share through.

## Quick start

```bash
git clone https://github.com/crcatala/agent-share-session.git
cd agent-share-session
npm install
npm run build
npm link                       # puts `agent-share` on PATH

agent-share list                                  # recent sessions (both harnesses)
agent-share report --current                      # what would be shared/redacted (writes nothing)
agent-share export <id> --mode full -o out.json   # redacted share JSON, locally
agent-share publish --current --mode brief        # review → confirm → secret gist → link
agent-share serve out.json                        # local viewer: …/session/#local:out.json
agent-share demo                                  # fake sessions in the local viewer, nothing uploaded
```

`serve` (and `demo`) listen on 127.0.0.1:3000 by default, so only this machine can
reach them. `--host 0.0.0.0` exposes them on your network (e.g. to open the viewer from
another device), and `--port` picks the port. If the port is taken it tries 3001, 3002, …
(up to 20 ports); `--strict-port` fails instead. The server hands the viewer and any share
files you pass it — only redacted exports — to anyone who can reach the port.

`<session>` is a file path, a session id, or an id prefix. `--current` uses
`$CLAUDE_CODE_SESSION_ID` inside Claude Code, otherwise the newest session for the
current directory. `--harness claude-code|pi` narrows the search; `--leaf <id>`
exports a specific branch of a tree-shaped (pi) session.

## Share modes

Projection happens **before** redaction and upload — omitted detail is never published,
not merely hidden by the viewer.

| mode | contents |
| --- | --- |
| `full` | Everything after redaction. Tool inputs/results are truncated per string (`maxToolChars`, default 20k). |
| `brief` (default for `publish`) | Prompts and assistant replies. Consecutive tool calls collapse into groups such as `Bash ×5 · Edit ×3`, with file lists and one-line commands; thinking becomes a count/token chip. No tool output. |
| `minimal` | Prompts, the final reply per turn, and per-turn tool counts. |

All modes keep metadata (harness, models, repo/branch, duration, tool counts, tokens,
cost) and per-response token usage. The viewer can step *down* (full → brief → minimal)
but never up.

## Redaction

Layers, in order (see `src/redact/`):

1. **Structural drop** — never exported: Claude Code `attachment` entries (CLAUDE.md,
   environment, credential org, reminders…), `<system-reminder>` blocks, meta/skill
   bodies, sidechains, system prompts and tool schemas, thinking signatures, image data.
   The report lists what was dropped.
2. **Known local values** — exact values of secret-looking env vars
   (`*KEY*|*TOKEN*|*SECRET*|*PASSWORD*…`), pi/Claude/Codex credential files, `gh auth token`,
   `~/.npmrc`, `~/.netrc`, and the session project's `.env*` files. Replaced with
   `[REDACTED:<NAME>]`. Catches secrets in any format.
3. **Patterns** — [`@sanity-labs/secret-scan`](https://github.com/sanity-labs/secret-scan)
   (~1,100 TruffleHog-derived rules). Prefix-anchored rules (GitHub, Anthropic, OpenAI,
   AWS, Stripe, Slack, JWT, private keys, connection strings…) are trusted; generic
   keyword rules must also look random (entropy, mixed letters/digits, not a hash/UUID,
   not a fragment of a longer token). Plus own rules: `password=`-style assignments,
   URL credentials, auth headers, sensitive JSON keys, age secret keys, PEM blocks.
   Documentation examples (`…EXAMPLE`, sequential runs) are ignored.
4. **Paths/PII** — home directory → `~` (also path slugs like `-home-<user>-…`),
   username → `[user]`, emails → `[email]` (no-reply/example addresses kept). Repo and
   project names are kept. Hostname redaction is opt-in.
5. **Final re-scan** of the exact payload bytes: any known value, high-confidence
   pattern or home path still present **blocks publishing**.

Report status:
- **CLEAN** — no secrets found; `publish --yes` publishes without prompting.
- **NEEDS REVIEW** (exit 2) — secrets were redacted; the report shows redacted context.
  Publishing requires an interactive "y" or `--yes --allow-findings`.
- **BLOCKED** (exit 3) — the re-scan found something; publishing is refused.

Pattern redaction is best effort: novel formats, secrets split across lines, or
proprietary code in `full` mode can still leak. Review before sharing publicly;
if something leaks, rotate it — deleting the gist does not undo exposure.

Evaluation on the author's 391 local sessions (360 MB): 0 errors, 0 blocked;
`brief` needs review on 14 sessions (11 s total), `full` on 53 (81 s). Real finds
included a full `env` dump with a dozen API keys and an age secret key.

## Config

`~/.config/agent-share/config.json` (or `$AGENT_SHARE_CONFIG`):

```json
{
  "viewerUrl": "https://agent.nub.sh/session/",
  "target": "gist",
  "r2": {
    "accountId": "<cloudflare-account-id>",
    "bucket": "agent-share",
    "prefix": "s/",
    "publicUrl": "https://shares.example.com"
  },
  "maxToolChars": 20000,
  "redact": {
    "emails": true,
    "username": true,
    "hostname": false,
    "denylist": ["Project Codename"],
    "allowlist": ["a-known-public-test-token"]
  }
}
```

Environment overrides: `AGENT_SHARE_VIEWER_URL`, `AGENT_SHARE_TARGET` (`gist` | `r2`).
`publish --target r2` overrides the target per run. `--secrets-file <file>` (on
`report`/`export`/`publish`) adds exact values to redact: `UPPER_SNAKE=value` lines are
split at the first `=`; any other line is redacted whole (so base64 padding or an `=`
inside a bare secret never drops or partly reveals it). Values under 4 characters are
skipped with a warning.

## Architecture: static only

There is no backend and no auth. Shares are public-by-link files; the viewer is static
HTML/JS that fetches them in the browser. Self-hosting means forking this repo,
tweaking it, and deploying your own copy of the viewer — so you know exactly which code
renders what you share.

```
agent-share publish ──upload──► gist  or  public R2 bucket   (your credentials, from your machine)
                                        ▲
viewer (static, any host) ──fetch───────┘  …/session/#owner/gistId  or  …/session/#r2:<id>
```

## Storage targets

**Gist (default).** `publish` creates a *secret* gist (`gh gist create` without
`--public`) containing `session.json` and prints `<viewerUrl>#<owner>/<gistId>`. Secret
gists are unlisted, not private, and GitHub keeps revisions.

**Public R2 bucket.** `publish --target r2` uploads `s/<random-id>.json` with the S3 API
and prints `<viewerUrl>#r2:<id>`. Ids are 128-bit random and public R2 buckets cannot be
listed, so shares stay unlisted. One-time setup:

1. Create a bucket and enable public access — a custom domain is recommended
   (`r2.dev` URLs are rate-limited and meant for development).
2. Allow the viewer's origin to fetch from it (CORS):
   ```bash
   cat > cors.json <<'JSON'
   { "rules": [ { "allowed": { "origins": ["https://agent.example.com"], "methods": ["GET"] } } ] }
   JSON
   npx wrangler r2 bucket cors set agent-share --file cors.json
   ```
3. Create an R2 API token with *Object Read & Write* on that bucket and export it:
   `AGENT_SHARE_R2_ACCESS_KEY_ID` / `AGENT_SHARE_R2_SECRET_ACCESS_KEY`
   (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` also work).
4. Add the `r2` section to the CLI config (above) and the matching source to
   `viewer.config.json` (below), then redeploy the viewer.

After an R2 upload, `publish` fetches the object with the viewer's `Origin` and warns if
public access or CORS is not set up.

**Deleting.** `agent-share delete <viewer-link | gist URL | r2:<id> | id>` removes a
share (`gh gist delete`, or an R2 `DELETE`). Anything already fetched or cached (R2
objects are cached for up to 5 minutes) may linger, so rotate anything that leaked.

## The viewer

A static page that reads the share location from the URL hash (never sent to the
server):

| hash | source |
| --- | --- |
| `#owner/gistId` | `gist.githubusercontent.com` raw URL (no API rate limit) |
| `#gist:<id>` / `#<id>` | GitHub API (60 req/h per IP unauthenticated) |
| `#<source>:<id>` | a source from `viewer.config.json`, e.g. `#r2:<id>` |
| `#local:<name>` | file served by `agent-share serve` |
| `#url:<path>` | same-origin path |
| `…&view=minimal` | step the view down |

Transcripts are untrusted: anyone can make a gist and send a link to your viewer. The
header says where the share was loaded from (for gists, the owner as GitHub reports it)
and that the content isn't verified. Markdown is sanitized with DOMPurify and may not
carry classes (other than code-block languages), ids, form controls or dialogs, so it
can't imitate the viewer's own UI; the CSP blocks scripts and remote images.

It renders prompts/replies, tool calls with
lazily-built detail, grouped work, subagent cards, events, and a per-turn **token rail**:
one column per model response showing prompt size (cache read / cache write / new input,
scaled to the session's peak context) plus a separate output row, with per-turn and
cumulative session totals and hover tooltips.

**Build-time config** — `viewer.config.json` lists extra share sources as URL templates:

```json
{ "sources": { "r2": "https://shares.example.com/s/{id}.json" } }
```

The template must equal the CLI's `r2.publicUrl` + `r2.prefix` + `{id}.json`. Each
source's origin is added to the Content-Security-Policy; the viewer only ever fetches
from GitHub gist hosts and the sources you list. (`$AGENT_SHARE_VIEWER_CONFIG` points
the build at a different file.)

**Build output** (`npm run build:viewer`, via Vite → `viewer/dist/`): `session/` (the
viewer, with relative asset URLs so any base path works), `_headers` (CSP with
`frame-ancestors 'none'`, `noindex`, `no-referrer`, `nosniff`), `_redirects`
(`/` → `/session/`) and `robots.txt`. Any static host works; Cloudflare reads
`_headers`/`_redirects` natively.

### Developing the viewer

```bash
npm run dev     # Vite dev server → http://localhost:3000/session/
```

- **HMR:** CSS edits hot-swap in place; TypeScript edits reload the page (the viewer is
  framework-free), which keeps the open session because it lives in the URL hash.
- **Data:** the fixture sessions are served at `/session/local/` (generated into
  `fixtures-out/` on first run), so the picker lists them immediately. Point it at other
  exports with `AGENT_SHARE_DEV_SHARES="a.json b.json" npm run dev`.
- **CSP:** dev only allows inline styles and the HMR WebSocket; builds keep the strict
  policy.
- **File access:** Vite may only read `viewer/` and `src/` (`server.fs.allow`), so the
  any-hostname setting cannot be used to read other files in the checkout (raw
  transcripts, a secrets file) via `/@fs/`.
- **Network:** listens on localhost only; `npm run dev -- --host` exposes it on all
  interfaces. Any hostname is accepted (VPS domain, Tailscale name, tunnel).
- `npm run preview:cf` builds and runs the viewer in Cloudflare's local runtime
  (`wrangler dev`) to check `_headers`/`_redirects` exactly as deployed.

### Deploying to Cloudflare

`wrangler.jsonc` defines an assets-only Worker (no Worker code, no bindings):

```bash
npx wrangler login          # once
npm run deploy              # builds the viewer and deploys it
# → https://agent-share-viewer.<your-subdomain>.workers.dev/session/
```

Custom domains (e.g. `agent.example.com`) are attached to the Worker in the Cloudflare
dashboard; nothing in this repo assumes a domain. Set the CLI's `viewerUrl` to wherever
you deployed (`https://…/session/`).

## Integrations

- **Claude Code** — `integrations/claude-code/share-session/SKILL.md`. Install:
  `ln -s "$PWD/integrations/claude-code/share-session" ~/.claude/skills/share-session`,
  then `/share-session [full|brief|minimal]`.
- **pi** — `integrations/pi/agent-share.ts` registers `/share-session` (pi's own `/share`
  is untouched). It passes the exact session file and live branch leaf. Install:
  `ln -s "$PWD/integrations/pi/agent-share.ts" ~/.pi/agent/extensions/agent-share.ts`.
  Set `AGENT_SHARE_BIN` if `agent-share` is not on PATH.

Both publish directly when the report is clean and ask for confirmation otherwise.

## Subagents

Subagent runs are detected (Claude Code `Agent`/`Task`; pi `subagent` launches, not its
management actions) and kept as metadata only: agent names, task description, mode,
async flag, error state and any usage the result reports (tokens, turns, tool uses,
duration, cost). Child transcripts are not included.

## Adding a harness

1. Write `src/adapters/<name>.ts` that turns the native transcript into a
   `NormalizedSession` (use `TurnBuilder` from `adapters/shared.ts`: `startTurn`,
   `addStep`, `addToolCall`/`attachToolResult`, `setResponseUsage`).
2. Register it in `src/adapters/index.ts` (`detect` + `parse`) and add the name to
   `HarnessName` in `src/schema.ts`.
3. For `--current`/id lookup, teach `src/resolve.ts` its session directory layout.

Everything downstream (stats, modes, redaction, publish, viewer) works on the normalized
format unchanged.

## Development

```bash
npm test            # vitest (fixtures are generated in code; fake secrets are assembled at runtime)
npm run typecheck   # CLI + viewer
npm run build       # dist/ (CLI) + viewer/dist/ (Vite)
npm run dev         # viewer dev server with HMR and the fixture sessions
npm start -- report --current   # run from source via tsx
```

### Fake sessions for testing

`agent-share fixtures` (or `npm run fixtures`) writes realistic, deterministic Claude
Code and pi transcripts — plus redacted shares in every mode — that exercise the whole
viewer (thinking, all tool kinds, errors, diffs, images, subagents, slash commands,
skills, interrupts, API errors, compaction, model changes, rewinds/branches, queued
prompts, a truncated build log) and every redaction layer (an `env` dump, `.env`, keys
in each detector's format, a PEM key, a JWT, and a format-less token that only
`--secrets-file` catches). Planted credentials are random fakes.

Quickest way to look at the viewer locally — generates the fixtures, exports shares in
every mode, and serves them (nothing is uploaded):

```bash
npm run demo          # or: agent-share demo [--seed 2] [--turns 30] [--port 3000]
# All sessions: http://localhost:3000/session/   ← picker listing every local share
```

Opening the viewer without a share in the link shows that picker whenever it is served
by `agent-share serve`/`demo` (it reads `./local/index.json`; deployed viewers have none).

```bash
agent-share fixtures --out fixtures-out --seed 1 [--turns 30]
agent-share serve fixtures-out/shares/*.json                       # browse them
agent-share report fixtures-out/claude/projects/*/*.jsonl --mode full --secrets-file fixtures-out/secrets.env
AGENT_SHARE_CLAUDE_PROJECTS=fixtures-out/claude/projects agent-share list
```

Transcripts use your home directory and username by default (so home-path redaction
applies); pass `--home`/`--user` to change them.
