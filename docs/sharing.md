# Sharing

What goes into a share (modes), where it is stored (targets), and the offline alternative
(single-file HTML).

## Share modes

Projection happens **before** redaction and upload — omitted detail is never published,
not merely hidden by the viewer.

| mode | contents |
| --- | --- |
| `full` | Everything after redaction. Tool inputs/results are truncated per string (`maxToolChars`, default 20k). |
| `brief` (default for `publish`) | Prompts and assistant replies. Consecutive tool calls collapse into groups such as `Bash ×5 · Edit ×3`, with file lists and one-line commands; thinking becomes a count/token chip. No tool output. |
| `minimal` | Prompts, the final reply per turn, and per-turn tool counts. |
| `prompts` | Only authored user prompts, followed by a compact, non-expandable activity line: tool calls/errors, unique files read/edited/written, thinking tokens and output tokens. No replies, thinking text, filenames, commands, tool inputs/results, subagent descriptions/results, event details, or expanded template/skill instructions. |

Instruction files (`CLAUDE.md`, `AGENTS.md`) and other injected context are never shared, in any
mode. In `full` mode, `--include-system-prompt` adds the harness's system prompt (Claude Code
only); see [Injected context](redaction.md#injected-context) for what it holds and why the
instruction files stay out.

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

## Branches

Rewinding (Claude Code) or branching (pi) leaves the abandoned turns in the session file. Only the
current branch is shared: the chain of parent links from the leaf, which is the last entry or the
one passed as `--leaf` (an id that is not in the file is an error). Other branches are never shared,
however much longer they are; the tokens and cost spent on them are reported as "not counted".

If a Claude Code chain stops at a parent that is missing from the file, the history before the
break is not exported either, since nothing tells it apart from a discarded branch. The report lists
the break as `broken-chain` under "Dropped". None of 150 local sessions checked had one.

## Storage targets

### Secret GitHub gist (default)

Needs the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`). `publish` creates a *secret* gist (`gh gist create` without
`--public`) containing `session.json` and prints `<viewerUrl>#<owner>/<gistId>`. Secret
gists are unlisted, not private, and GitHub keeps revisions.

### Public Cloudflare R2 bucket

`publish --target r2` uploads `s/<random-id>.json` with the S3 API
and prints `<viewerUrl>#r2:<id>`. Ids are 128-bit random and public R2 buckets cannot be
listed, so shares stay unlisted. One-time setup:

1. Create a bucket and enable public access — a custom domain is recommended
   (`r2.dev` URLs are rate-limited and meant for development).
2. Allow the viewer's origin to fetch from it (CORS):
   ```bash
   cat > cors.json <<'JSON'
   { "rules": [ { "allowed": { "origins": ["https://agent.example.com"], "methods": ["GET"] } } ] }
   JSON
   npx wrangler r2 bucket cors set overshare --file cors.json
   ```
3. Create an R2 API token with *Object Read & Write* on that bucket and export it:
   `OVERSHARE_R2_ACCESS_KEY_ID` / `OVERSHARE_R2_SECRET_ACCESS_KEY`
   (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` also work).
4. Add the `r2` section to the [CLI config](configuration.md) and the matching source to
   [`viewer.config.json`](self-hosting.md#build-time-config), then redeploy the viewer.

After an R2 upload, `publish` fetches the object with the viewer's `Origin` and warns if
public access or CORS is not set up.

### Deleting a share

`overshare delete <viewer-link | gist URL | r2:<id> | id>` removes a
share (`gh gist delete`, or an R2 `DELETE`). Anything already fetched or cached (R2
objects are cached for up to 5 minutes) may linger, so rotate anything that leaked.

## Single-file HTML

`overshare export <id> -o session.html` (or `--format html`) writes the viewer and one redacted session as a
single page: JS, CSS and fonts inline, the session embedded as JSON, nothing fetched. It opens from disk, an email
attachment or any static host, with no viewer deployment, gist or bucket. It goes through the same pipeline as
every other export (modes, redaction, re-scan); unlike a JSON export, an HTML one is not written if the re-scan blocks the share.

It is a different tradeoff from a link, not a replacement:

- **Frozen viewer.** The file carries the viewer that wrote it, so later viewer fixes don't reach it (a hosted
  viewer link always gets the latest).
- **No revocation.** A gist or bucket object can be deleted; a copy of a file can't. Treat it like any file that
  holds a transcript: review the report first (`export` prints a reminder, even with `-q`). Unlike `publish` and
  `browse`, `export` has no confirm step.
- **Size.** About 0.9 MB of viewer (mostly fonts) plus the session; `full` mode shares of long sessions can be many MB.
- **Links.** The share menu's links point at the file's own address (`#&turn=3`), so they work wherever the file is
  hosted, and only on your machine if it isn't.
- **Hosting.** Gists serve files as plain text, so they can't show it; a bucket needs `content-type: text/html`.
  `publish` doesn't produce it yet.

**Security.** The page's Content-Security-Policy allows exactly its own script and style by hash, fonts and images only as
`data:`, and no connections (`connect-src 'none'`). It comes from a `<meta>` tag, which is all a file on disk can have;
send the same policy as a header when hosting it. Markdown sanitising and remote-content blocking are the hosted
viewer's, unchanged.

## Subagents

Subagent runs are detected (Claude Code `Agent`/`Task`; pi `subagent` launches, not its
management actions) and kept as metadata only: agent names, task description, mode,
async flag, error state and usage (tokens, model calls, tool uses, duration, cost; for Claude
Code summed from the subagent's own transcript, plus a bounded summary of its final message).
Child transcripts are not included.
