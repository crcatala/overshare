# agent-share

Share coding-agent sessions (Claude Code, pi) as **redacted, unlisted links** with a
static viewer. Transcripts are normalized into one harness-agnostic format
(`agentshare/2`), redacted locally, projected to a share mode, re-scanned, and only
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

agent-share browse                                # interactive: find an old session, preview it, share it
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

## Browsing sessions (`agent-share browse`)

An interactive browser for finding an older session and sharing it. It lists every local Claude Code and pi session
with a preview, filters and search, a two-pane session viewer, and a publish dialog that runs the same redaction
and final re-scan as `publish`. Needs a terminal (Node ≥ 22.19).

```
agent-share  7/7
 harness: all   repo: all   time: any   shared: any   group: date   sort: default ↓
/ search  ·  harness:pi  since:7d  shared:no  tool:Bash  model:opus
── Today ─────────────────────────────────────────────── │ Fix invoice currency bug
▌1h ago     CC billing    Fix invoice currency bug     ✓  │ Claude Code · opus-5-5 · feat/money · 32m 0s
 3h ago     π  billing    Refactor money helpers          │ 9 prompts · 41 model calls · 878.9 KB
── Yesterday ─────────────────────────────────────────── │ Bash ×12 · Read ×7 · Edit ×3
 yesterday  CC web        Onboarding empty state          │
```

| Key | Does | With Shift |
| --- | --- | --- |
| `j` `k` / arrows | move (`home`/`end`) | |
| `space` `b` | page down / up (also `PgDn`/`PgUp` and `ctrl-f`/`ctrl-b`; `ctrl-d`/`ctrl-u` move half a page) | |
| `/` | search: free words plus `harness:pi repo:x branch:y model:opus tool:Bash since:7d before:2026-09-01 shared:no workers:yes` | |
| `h` `r` `t` `s` | cycle harness · repo · time · shared | `H` `R` `T` `S`: pick from a dialog (`/` filters the repo list; a long list scrolls in a fixed 10-row window with a row of dots for your position, and `PgUp`/`PgDn` page it) |
| `g` | cycle grouping: none → date → repo → harness | `G`: dialog |
| `o` | cycle sort field (size, title, repo, prompts, calls, duration, updated); selects the first session | `O`: dialog with field and direction |
| `x` | clear search and filters (grouping and sort stay); shown in the footer while there is something to clear | |
| `enter` | open the session viewer | |
| `p` | publish: mode → review → confirm (`enter` continues; only `y` publishes) | |
| `y` | copy the share link (terminal clipboard, OSC 52) | |
| `,` | settings: confirm before quitting, date format | |
| `?` / `q` | help / clear filters, then quit (asks first unless you turned that off) | |

The filter chips under the title double as a key legend: the hotkey letter in each (**h**arness, **r**epo, **t**ime,
**s**hared, **g**roup, s**o**rt) is bold and underlined. Changing a filter, the search or the sort selects the first session again
and scrolls to it; grouping keeps the selection where it is.

In the viewer the left pane lists messages and the right pane shows the selected one in full; the header has the
tool-call breakdown and whether a `brief` share would be clean. Each pane is a rounded panel (the message heading sits in the content panel's top border), and the one with the focus
has the bright border while the other is gray; the list's selected row dims when the content has the focus. `enter`, `tab`, `l` or `→` move the focus to the content pane; `esc`, `tab`,
`h`, `←` or `q` bring it back, and from the list `esc`/`q`/`h`/`←` leave the viewer. Both panes take the same keys as the
session list: `j`/`k` or the arrows move (a message in the list, a line in the content), `space`/`PgDn`/`ctrl-f` and
`b`/`PgUp`/`ctrl-b` page, `ctrl-d`/`ctrl-u` half a page, `g`/`G` first/last. `v` cycles the list between your prompts, the
conversation, and everything (tool calls, thinking, subagents, skills); `J`/`K` jump between prompts from either pane. `y` copies the
selected message to the clipboard (OSC 52, like the share link) as plain text: for a tool call, its input and result too. `V` opens the same
choice as a dialog and adds three options that are saved and apply at every level: indent assistant replies under
their prompt, indent tool calls (with thinking, subagents and events) one level further, and mark each row with an icon
(`❯ ◆ ⚙`, the default) or with its kind in brackets (`[User]` `[Assistant]` `[Tool]` `[Thinking]` `[Subagent]` `[Skill]` `[Event]`). A kind keeps its colour in
the list and in the heading of the content pane, whichever marker you pick.

The content pane formats what it shows: an assistant reply as markdown (headings, lists, tables, quotes, highlighted code
fences); a prompt as you typed it (not markdown); a `Bash` call as highlighted shell with its output below; an `Edit` (Claude
Code's, `MultiEdit`, or pi's `edit`) as a red/green diff with unchanged stretches collapsed; a `Write` as the file's code; any other tool as its JSON
input, then its result.

The list's preview also shows the **last reply** (the last thing the assistant said in words), and each session's **branch**: the one
the transcript recorded (Claude Code) or, where there is none (pi), a best guess marked `~` in the list and "(guess)" in the preview. The guess comes from the repo's own
files, with no `git` process: HEAD's reflog says which branch was checked out when the session ended, and a repo that never switched is on its
current branch. It is wrong when the reflog has expired (90 days), the branch was deleted or renamed, or the working directory is gone. The list
shows a branch column only when the terminal is wide enough to leave the titles room (about 140 columns); `branch:name` searches both kinds.

### Browser settings

Preferences live in `~/.config/agent-share/browse.json` (`AGENT_SHARE_BROWSE_SETTINGS` overrides), separate from
`config.json` because the browser rewrites this file whenever you change one in the UI. A missing or invalid file, or
field, falls back to its default.

```json
{ "confirmQuit": true, "dateFormat": "relative", "viewer": { "indentReplies": false, "indentTools": false, "markers": "icon" } }
```

| Setting | Values | Where |
| --- | --- | --- |
| `confirmQuit` | `true` (default) asks "Quit agent-share?" before leaving; `false` quits at once | `,` |
| `dateFormat` | `relative` (default, `5h ago`) · `smart` (`14:05` today, `Jul 14`, `2025-07-14`) · `short` (`Jul 14 14:05`) · `date` (`2026-07-14`) · `datetime` (`2026-07-14 14:05`); local time except relative | `,` |
| `viewer.indentReplies` | indent assistant replies one level under their prompt (default `false`) | `V` in a session |
| `viewer.indentTools` | indent tool calls, thinking, subagents and events one level deeper than replies (default `false`) | `V` in a session |
| `viewer.markers` | `icon` (default, `❯ ◆ ⚙ …`) or `text` (`[User] [Assistant] [Tool] [Thinking] [Subagent] [Skill] [Event]`) to mark each row of the message list | `V` in a session |

`ctrl-c` always quits immediately, without asking.

- **Index.** Session summaries (title, repo, branch, models, first/last prompts, last reply, tool counts) are cached in
  `~/.cache/agent-share-session/index.json` (`AGENT_SHARE_INDEX` overrides), keyed by path, mtime and size. The first run reads
  every transcript (a couple of seconds for ~500 sessions); later runs only `stat` the files. The list appears at once, with
  `reading…` rows that fill in (newest first) while a counter shows progress; keys work meanwhile, search and the repo filter
  cover only the sessions read so far, and a row cannot be opened or published until it has been read. The cache is saved
  as it goes, so quitting midway keeps what was read. The cache and `shares.json` are written
  readable by you only (0600), since they hold prompt text and unlisted share links.
- **Target.** The publish dialog names where the share goes, starting on your configured `target`; `t` switches between gist and R2 for
  that one publish (the config is never rewritten). A target that is not set up (no `r2` section, no credentials) is marked `✗`, says what
  is missing and cannot be published to. The review is made for the target on screen, so switching scans again and what you reviewed is what is uploaded there.
- **Shared marks.** Every successful `publish` (CLI or browser) is recorded in `~/.local/state/agent-share-session/shares.json`
  (`AGENT_SHARE_SHARES` overrides). The browser shows a ✓ on those sessions and can filter by them.
- **What gets published.** The publish dialog reviews the chosen mode with the real pipeline and uploads exactly the payload you
  reviewed. Modes the pipeline refuses (for example `prompts` on a legacy pi session) say why and cannot be selected; a blocked
  re-scan cannot be published, and suspicious values (see "Suspicious values") need an extra confirmation first. The viewer itself shows your local transcript unredacted, because it never leaves your machine.
- **Terminal safety.** Errors inside the UI show in the footer instead of crashing; on any exit the terminal modes are restored.
  Transcript text is untrusted, so terminal control sequences in it (clipboard writes, title changes, screen clears) are stripped
  before anything is drawn.
- **Subagents.** Like `publish`, the browser reads a Claude session's subagent transcripts, so its viewer and reviewed payload match the CLI's.

## Share modes

Projection happens **before** redaction and upload — omitted detail is never published,
not merely hidden by the viewer.

| mode | contents |
| --- | --- |
| `full` | Everything after redaction. Tool inputs/results are truncated per string (`maxToolChars`, default 20k). |
| `brief` (default for `publish`) | Prompts and assistant replies. Consecutive tool calls collapse into groups such as `Bash ×5 · Edit ×3`, with file lists and one-line commands; thinking becomes a count/token chip. No tool output. |
| `minimal` | Prompts, the final reply per turn, and per-turn tool counts. |
| `prompts` | Only authored user prompts, followed by a compact, non-expandable activity line: tool calls/errors, unique files read/edited/written, thinking tokens and output tokens. No replies, thinking text, filenames, commands, tool inputs/results, subagent descriptions/results, event details, or expanded template/skill instructions. |

All modes keep metadata (harness, models, repo/branch, duration, tool counts, tokens,
cost) and per-model-call token usage. The viewer's **view mode dropdown** can step *down*
(full → brief → minimal → prompts) but never up; unavailable modes explain which detail
was not published. The dropdown is also available in the sticky header, including on mobile.

Activity counts are per turn; repeated reads/edits of the same file count once per action,
while every tool invocation (including subagent calls) counts. Zero or unavailable token
metrics are omitted. “Output tokens” means reported model-call output, including
thinking and tool-call generation—not a measurement of final-reply prose alone. Prompts
shares retain only numeric turn activity and token usage alongside authored prompts and
session metadata; the omitted content is stripped **before redaction and upload**.

Pi normally persists expanded prompt-template and skill text as an ordinary user message.
The updated pi share extension records the pre-expansion input as branch-local provenance
and binds it to the exact message by parent, timestamp, and content hash. Historical pi
sessions, queued expansions, and extension-injected messages cannot be verified reliably;
`prompts` export, publish, report, and viewer projection **fail closed** for those prompts
instead of guessing. Other modes still show the stored text and must be reviewed.

## Redaction

Layers, in order (see `src/redact/`):

1. **Structural drop** — never exported: Claude Code `attachment` entries (CLAUDE.md,
   environment, credential org, reminders…), `<system-reminder>` blocks, meta/skill
   bodies, sidechains, system prompts and tool schemas, thinking signatures, image data.
   The report lists what was dropped.
2. **Known local values** — exact values of secret-looking env vars
   (`*KEY*|*TOKEN*|*SECRET*|*PASSWORD*…`) and the session project's `.env*` files, plus anything
   you opt in to or declare (see [What this tool reads and why](#what-this-tool-reads-and-why)).
   Replaced with `[REDACTED:<NAME>]`. Catches secrets in any format.
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
   pattern or home path still present **blocks publishing**. As a backstop (never the guard against a secret cut in two
   before redaction) it also looks for a long, random-looking prefix or suffix of a known value (**blocks**) or of a secret a
   pattern redacted (**needs confirmation**); ordinary text a value starts or ends with, like `postgres://user:` or a host name, never counts.

Report status:
- **CLEAN** — no secrets found; `publish --yes` publishes without prompting.
- **NEEDS REVIEW** (exit 2) — secrets were redacted; the report lists each finding by rule and location.
  Publishing requires an interactive "y" or `--yes --allow-findings`.
- **NEEDS CONFIRMATION** (exit 2) — see "Suspicious values" below. Publishing requires an interactive "y" to a
  question that says so, or `--yes --allow-suspicious`.
- **BLOCKED** (exit 3) — the re-scan found something; publishing is refused.

#### Suspicious values

The final re-scan blocks on high-confidence matches (known values, prefix-anchored formats like `ghp_`/`sk-ant-`, private keys,
URL credentials, auth headers). It also looks for **medium-confidence** matches (`password=…`-style assignments, generic
keyword rules that look random) in the exact outgoing bytes. The redactor already replaces every medium match in the text it
walks, so what the re-scan can still find sits where the redactor does not look: object keys, and fields outside the
conversation text. Those are reported as **suspicious**: they may be secrets, they are still in the payload, and you decide.

- The report (terminal, `--json`, browse dialog) lists each one by rule, length and **location** (`turn 3 · Bash · input (object key)`,
  turn numbers as in `agent-share browse`), the **line numbers** of the transcript file where the value is (`… · line 42`; up to five,
  then `(+N more)`; a hit in a Claude Code subagent transcript is labelled `subagent-file-N`, numbered in file-name order, never by name), plus the transcript file to look at. Never the
  value, a fragment or a hash. Blocked re-scan issues carry the same location and lines, in the terminal and in the browse dialog.
  The lines are found by looking the value up in the source file, not read off the payload, so they never reach the upload; a value
  that only exists after a transformation (not verbatim in the file) is reported by turn and step alone.
- `publish --yes` stops with exit 2 and does not publish; `--allow-findings` does not cover it either, because those secrets are
  redacted and these are not. After inspecting the values, pass `--allow-suspicious`, or add a value that is fine to
  `redact.allowlist` so it is not reported again.
- In `agent-share browse`, a payload with suspicious values gets an extra screen before the final confirmation, needing an explicit
  `c`; enter never continues, and nothing is sent before the final `y`.
- Expect this to be rare: on 486 of the author's local sessions it fired on none. Honest limit: it only surfaces what a pattern
  layer matched. A secret with **no recognizable format** matches nothing, so no layer reports it; that is what the known-value
  sources are for, and this tier does not make up for turning them off.

Findings and final re-scan issues (terminal, `--json` and the browse dialog) show rules, locations,
counts and a length, never a secret value, a fragment of one, or the text around a finding: an
unredacted secret next to a caught one would otherwise be printed into your terminal and CI logs.
Names taken from the data (env/JSON key names, tool names) appear only if they look like plain
identifiers, otherwise as `secret`, `key` or `tool`. The same check applies to the session id, model ids
and the name of a project `.env` file. Tool call ids and response ids that the transcript supplies
go through the exact-value and secret-pattern rules before they are uploaded (not the email and path
rules, which could mangle an id); a secret in one that no pattern recognises is only caught by the final re-scan.

### What this tool reads and why

Exact-value replacement is the only layer that catches a secret with no recognizable format
(a custom internal key, a short password). To do that, `report`, `export`, `publish` and the
browse publish dialog collect secret values from your machine at the start of each run. They
live in process memory for that run only: never written to disk, never printed (reports show
source names and counts, never values), and held in a type that refuses to be stringified.

| Source (`redact.knownSources.<name>`) | What is read | Default |
|---|---|---|
| `env` | secret-looking environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`…) | **on** |
| `projectEnv` | the session project's `.env*` files (not `.example`/`.sample`/`.template`) | **on** |
| `credentialFiles` | pi `auth.json`, Claude `.credentials.json`, Codex `auth.json`, `~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.netrc` | off |
| `ghToken` | runs `gh auth token` | off |

`env` and `projectEnv` are on because they are already in the process or in the project the session
worked in, and agent transcripts are full of `printenv` and `cat .env` output. The other two read
credential stores a share tool is not expected to open, so you choose them. Turn them on in the config:

```json
{ "redact": { "knownSources": { "credentialFiles": true, "ghToken": true } } }
```

Unknown source names and non-boolean values are config errors. Every report lists what was read and
what was not, with counts only, for example
`Known values: env (4), project .env (2); not read: credential files, gh auth token (disabled)`.
The same line is in `report --json` (`knownSources`) and in the browse publish dialog. This
is about the redaction step only: publishing to a gist still runs `gh auth status`,
`gh gist create` and `gh api`.

**The tradeoff.** With a source off, a secret that exists only there and has no recognizable format
can leak: the pattern and entropy layers only see what some rule matched, so an unformatted secret
that was not harvested is invisible to every layer. For values you know are sensitive, declare them
instead of enabling a credential store: `--secrets-file <file>` (exact values, per run) or
`redact.denylist` (literal strings, always).

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
    "allowlist": ["a-known-public-test-token"],
    "knownSources": { "env": true, "projectEnv": true, "credentialFiles": false, "ghToken": false }
  }
}
```

Environment overrides: `AGENT_SHARE_VIEWER_URL`, `AGENT_SHARE_TARGET` (`gist` | `r2`).
`publish --target r2` overrides the target per run; in `browse`, press `t` in the publish dialog. `--secrets-file <file>` (on
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
| `…&ui=log.brief.dark.L.toc-all` | open with these view settings (see *View settings*) |
| `…&turn=3` | open at prompt 3 |

Transcripts are untrusted: anyone can make a gist and send a link to your viewer. The
header says where the share was loaded from (for gists, the owner as GitHub reports it)
and that the content isn't verified. Markdown is sanitized with DOMPurify and may not
carry classes (other than code-block languages), ids, form controls or dialogs, so it
can't imitate the viewer's own UI. Remote sources are dropped before anything renders:
images, video and audio show a "remote image not loaded (host)" note instead, and SVG
resource references (`<image>`, `<use>`, `url()` in `fill`, `mask`, `cursor`, …) are
removed. The CSP (checked against the real build by the tests) blocks scripts and remote
requests as a second layer.

It reads like a terminal transcript: a centered mono column (640–840px depending on the
variant) you can scroll straight through. Each tool call is one line (`Bash(npm test)`,
`Edit(src/x.ts) +2 −1`) with a short preview of its output or diff under it; the full
input/output is built only when you open it. Brief/minimal shares show grouped work as
count badges (`Bash ×5 · Edit ×3`) with the files and commands involved. Code blocks and
output wrap instead of scrolling sideways, and markdown tables are drawn as text grids
that re-lay themselves out to the width (see below).

Around the transcript, without pushing it off-center:

- **Contents rail** (left): one row per prompt with its time and tool count; "all" adds
  the replies, tool runs and events inside each turn. Filter with `/`, click to jump; the
  turn in view is highlighted.
- **Token rail** (right): session totals; a *Cache* list of cache misses (below);
  *context by turn* — the largest prompt sent in each turn (stacked cache read / cache
  write / uncached input) with its output on a row below; the turn in view is marked and
  bars jump to their turn — then *the turn in view*, one bar per model call on the same
  session-wide scale (so turns can be compared), tool counts and files. Each chart labels
  the top of its scale.
- **Header**: title, agent/model/project/date, key stats, where the share was loaded
  from and that it isn't verified, and the controls (view mode, theme, settings, share).
  Once it scrolls away a one-line **minibar** takes over with the turn in view, reading
  progress and the controls; it spans the window, with its contents lined up with the
  rails.

**How the token rail counts.** Totals cover the model calls on the branch being shown,
including calls the agent made itself (pi compaction and branch summaries, tool-made calls,
cache keep-alives). Two things are kept out and reported on their own lines when present:
spend on *other branches* of the same file (rewound or abandoned work) and, for a pi
session forked from another, history *inherited* from the parent (drawn muted in the
charts). Subagent usage is kept out of these totals too, and shown on its own (next paragraph). *est. cost* is an estimate at API
list price, not a bill: pi records a cost for every call, while Claude Code records only
tokens, so its cost is computed from the token counts, the model and the 5-minute/1-hour
cache-write split with the price table in `src/pricing-data.ts` (regenerate it with
`node scripts/update-prices.mjs`; older models pi's catalog lacks are kept by hand in
`src/pricing.ts`). A model with no known price adds no cost rather than zero, and the
total then ends in `+`. The estimate can undercount: long-context, fast-mode and regional
price surcharges are not modelled. Thinking tokens are part of output. *tokens processed*
counts the whole prompt of every model call, so context re-read from cache is counted
again each time: it is far larger than the conversation (hover it for the split into cache
read, cache write, uncached input and output). *peak context* is the largest single prompt.

**Subagents.** For Claude Code the rail's Session figures are labelled *main conversation*, and a
separate *Subagents* section gives what the subagents cost on their own: how many, *tokens
processed*, *est. cost* and *model calls*, read from their transcripts (hover the cost for the
split by model). Subagents no step on the shown branch launched (a forked skill, a rewound
branch) are a *not launched here* row, never folded into either figure. The header fact reads
`subagents: 3 (~$0.03)`. Each subagent's own tokens and cost are on its step (open it for the
split by token class and the model), and the turn that launched it, even when it finished
later, shows what its subagents used in the turn box and footer. They are not drawn in
*Context by turn* (a subagent has its own context window) and not in the cache figures. pi
keeps its best-effort chip and no subagent totals.

**Cache misses.** The rail's *cache hit (tokens)* is the share of prompt tokens read from
cache; one miss on a large prompt can cost more than the rest of a session, so the count
of misses sits beside it, and a *Cache* section lists each one (turn, kind, gap since the
previous call, tokens re-cached, extra cost; click to jump), marked in the context chart
with a triangle (miss) or an open diamond (expected). The header adds *cache misses* only
when there are some. Detection uses Claude Code's own `/usage` rule and vocabulary, from
the token counts alone (`src/cache.ts`, run on the full session so share modes do not
change it): a *miss* is a model call that re-processed more than 5% and at least 2,000
tokens of the prompt the previous call could have read from cache (capped at this call's
prompt, so a rewind that reads everything from cache is not a miss). Two kinds are
expected and counted apart: a *rebuild* (the first call after a compaction) and a *model
switch* (caches are per model). Calls the agent made itself (compaction, keep-alives,
tool-made calls) are skipped, and so are providers that report no cache tokens. Idle
time is only the explanation, never the trigger: a miss is labelled "after 4h 31m idle"
when the gap outlasts the cache, and only as far as the data says how long it lives: 1 hour
when the writes are billed at the 1-hour rate, 5 minutes for Claude Code writes with no
1-hour breakdown (Anthropic's default), and for any other agent or provider, where no
transcript records the lifetime, only a gap over an hour. A shorter gap is still shown, just
not called idle. Providers that
never report cache writes (OpenAI-style, xAI, GLM, DeepSeek; Anthropic models always count as
explicit, any other model needs writes on a quarter of at least 4 calls) cache best-effort in coarse
blocks, so an ordinary call lags the previous prompt by a block or two; for an
unexplained miss on those, more than half the prefix and at least 10,000 tokens must have
been re-processed. The extra cost is the re-processed tokens at what the call paid (5-minute
or 1-hour writes, uncached input) minus the cache-read price: from the price table for
Claude Code, from the per-model prices in pi's recorded costs for pi.
Limits: the compaction request itself (which pays for a cold cache after an idle break) is not
written to Claude Code transcripts, so it cannot be flagged and only the rebuild after it shows.
Claude Code also counts tool-result clearing as an expected rebuild; no transcript we have
records it (`context_management` is always null), so such a call would show as a miss.

Both rails collapse (`«`/`»`, or `[` and `]`). When the window is too narrow to fit them beside the column they become overlays opened from the
minibar or the corner buttons. Keys: `j`/`k` next/previous prompt, `[`/`]` rails, `/`
filter the contents, `v`/`V` cycle design variants.

**Design variants.** Five looks share one DOM, for picking a direction. Pick one from the
settings menu (the sliders icon next to the theme toggle), with `v`/`V`, or with
`&ui=<variant>` in the link:

| variant | look |
| --- | --- |
| `classic` (default) | After pi's session export: one text edge, prompts and tool calls as tinted blocks (different tints), a bold `$ command` over its output, thinking in dim italics; warm cli/gruvbox palette. |
| `cli` | The agent's own terminal: `❯` prompts on a faint band, `●` tool lines with `└` output, markdown shown with its `##` markers, rounded tables, floating rail panels. |
| `timeline` | A vertical line with a node per step; turn numbers and times in a gutter; docs-style rails; the minibar is a floating pill. |
| `hybrid` | Proportional prose (IBM Plex Sans) for prompts and replies, mono for everything the agent did; tool activity on a quiet hairline; numbered turn rules. |
| `log` | A TUI log: `time │ role │ text` rows, framed panes with titles set into the border, a statusline and plain ASCII tables (gruvbox). |

**View settings.** How a session is shown — variant, view (full/brief/minimal/prompts), theme,
which rails are open and what the contents rail lists — as opposed to which session.
Where they come from, first match wins:

1. `&ui=` in the link, for just the fields it names. It is read when the link opens and
   then removed, so the address bar always shows the plain share link.
2. This tab's settings (sessionStorage), so a reload keeps what you were looking at. The
   tab keeps every field, so a default saved later (say, in another tab) applies to new
   tabs, not this one.
3. Your saved default: **Save as my default** in the settings menu (localStorage).
   **Reset to built-in default** forgets it.
4. The viewer's built-in default (`classic`, full, system theme, both rails, prompts).

Changing a control changes only this tab; nothing is remembered for other sessions until
you save it as your default, and the URL never tracks it. A view the share wasn't
published with falls back to the most it has; picking the most a share has is kept as
`full`, so a brief share never holds later ones to brief.

`&ui=` is dot-separated tokens that each say what they are, in any order: a variant id,
`full`/`brief`/`minimal`, `system`/`light`/`dark`, the open rails as `LR`/`L`/`R`/`-`, and
`toc-prompts`/`toc-all`. Unknown tokens are skipped, so an option that is renamed or
removed later only falls back to the reader's own setting. The **share** menu (next to
settings) copies a plain link or one with the current view (every field, with the theme
as shown), each either to the whole session or to the prompt in view (`&turn=`).

**Text tables.** Markdown tables become box-drawn grids sized in characters: columns
keep their longest word where possible, spare width goes to the columns with the most
body text (so a long header wraps before a long cell), emoji/CJK count as two columns,
and when even whole words can't fit, rows are shown as stacked `header  value` records.
The grid redraws when its container changes width; the original table stays in the DOM,
visually hidden, for screen readers. Inline code, emphasis and links are kept.

**Fonts.** The viewer bundles its fonts (no font CDN): a subset of JetBrains Mono that
includes box-drawing, block and geometric characters — the stock web subsets leave box
drawing out, and text tables only line up when every character comes from one font —
and IBM Plex Sans for the `hybrid` prose. The CSP allows `font-src 'self'`.

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

- **Variants:** `viewer/src/styles/<variant>.css` (scoped by `html[data-variant]`) over
  `base.css`; `viewer/src/variants.ts` lists them. Point the dev server at longer sessions
  to judge them: `agent-share fixtures --out /tmp/big --turns 120` then
  `AGENT_SHARE_DEV_SHARES="/tmp/big/shares/claude-code-full.json" npm run dev`.
- **HMR:** CSS edits hot-swap in place; TypeScript edits reload the page (the viewer is
  framework-free), which keeps the open session because it lives in the URL hash.
- **Data:** the fixture sessions are served at `/session/local/` (generated into
  `fixtures-out/` on first run), so the picker lists them immediately. Point it at other
  exports with `AGENT_SHARE_DEV_SHARES="a.json b.json" npm run dev`.
- **CSP:** dev only allows inline styles and the HMR WebSocket; builds keep the strict
  policy.
- **File access:** Vite may only read `viewer/`, `src/` and the bundled prose font's
  package (`server.fs.allow`), so the any-hostname setting cannot be used to read other
  files in the checkout (raw transcripts, a secrets file) via `/@fs/`.
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
  then `/share-session [full|brief|minimal|prompts]`. Reload the extension before a
`prompts` share: it must record the typed input before pi expands templates or skills.
- **pi** — `integrations/pi/agent-share.ts` registers `/share-session` (pi's own `/share`
  is untouched). It passes the exact session file and live branch leaf. Install:
  `ln -s "$PWD/integrations/pi/agent-share.ts" ~/.pi/agent/extensions/agent-share.ts`.
  Set `AGENT_SHARE_BIN` if `agent-share` is not on PATH.

Both publish directly when the report is clean and ask for confirmation otherwise.

## Subagents

Subagent runs are detected (Claude Code `Agent`/`Task`; pi `subagent` launches, not its
management actions) and kept as metadata only: agent names, task description, mode,
async flag, error state and usage (tokens, model calls, tool uses, duration, cost; for Claude
Code summed from the subagent's own transcript, plus a bounded summary of its final message).
Child transcripts are not included.

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
