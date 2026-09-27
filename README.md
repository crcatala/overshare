# agent-share

Share coding-agent sessions (Claude Code, pi) as **redacted, unlisted links** with a
static viewer. Transcripts are normalized into one harness-agnostic format
(`agentshare/1`), redacted locally, projected to a share mode, re-scanned, and only
then uploaded (currently as a secret GitHub gist).

```
adapters/            pipeline                                   publish/            viewer/
 claude-code.ts ─┐   parse → stats → project(mode) → redact     gist (now)          static page
 pi.ts          ─┴─► NormalizedSession ─────────► re-scan ────► R2 (later)   ─────► #owner/gistId
```

Standalone package: `cd tools/agent-share && npm install` — nothing depends on the
surrounding repository, so it can be extracted to its own repo as-is.

## Quick start

```bash
cd tools/agent-share
npm install
npm run build
npm link                       # puts `agent-share` on PATH

agent-share list                                  # recent sessions (both harnesses)
agent-share report --current                      # what would be shared/redacted (writes nothing)
agent-share export <id> --mode full -o out.json   # redacted share JSON, locally
agent-share publish --current --mode brief        # review → confirm → secret gist → link
agent-share serve out.json                        # local viewer: …/session/#local:out.json
```

`serve` listens on port 3000 on all interfaces by default (`--port`, `--host 127.0.0.1`
to keep it local). If the port is taken it tries 3001, 3002, … (up to 20 ports);
`--strict-port` fails instead. It serves the viewer and any share files you pass it — only
redacted exports — to anyone who can reach the port.

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

`AGENT_SHARE_VIEWER_URL` overrides `viewerUrl`.

## Storage and the viewer

`publish` creates a **secret gist** (`gh gist create` without `--public`) containing
`session.json` and prints `<viewerUrl>#<owner>/<gistId>`. Secret gists are unlisted,
not private, and GitHub keeps revisions: delete the gist to unpublish.

The viewer (`viewer/`) is a static page that reads the share from the URL hash (never
sent to the server):

| hash | source |
| --- | --- |
| `#owner/gistId` | `gist.githubusercontent.com` raw URL (no API rate limit) |
| `#gist:<id>` / `#<id>` | GitHub API (60 req/h per IP unauthenticated) |
| `#local:<name>` | file served by `agent-share serve` |
| `#url:<path>` | same-origin path (reserved for R2 storage) |
| `…&view=minimal` | step the view down |

It renders prompts/replies (markdown sanitized with DOMPurify), tool calls with
lazily-built detail, grouped work, subagent cards, events, and a per-turn **token rail**:
one column per model response showing prompt size (cache read / cache write / new input,
scaled to the session's peak context) plus a separate output row, with per-turn and
cumulative session totals and hover tooltips. A strict CSP allows scripts only from
its own origin, fetches only to GitHub gist hosts, and blocks remote images.

Hosting at `agent.nub.sh/session/`: `npm run build:viewer` and deploy `viewer/dist/`
(e.g. Cloudflare Pages). For R2, add a `Publisher` in `src/publish/` that uploads
`session.json` under an unguessable id and returns `…/session/#url:/s/<id>.json`, then
add the R2 origin to the CSP `connect-src` if it differs.

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
npm run build       # dist/ + viewer/dist/
npm start -- report --current   # run from source via tsx
```
