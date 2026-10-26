# Archiving sessions as markdown

`overshare archive` saves redacted sessions as markdown files on your machine: a record of past sessions you
can read, search and keep in notes. It runs the same pipeline as `publish` (share mode, redaction, final
re-scan), but nothing is uploaded and nothing waits for a confirmation.

```bash
# One session, into the archive folder
overshare archive --current
overshare archive 3f2a --mode brief

# Every session with activity in the last 30 days (or --since 7d, 12h, 2w, 2026-10-01)
overshare archive --all
overshare archive --all --since 7d --harness pi

# Somewhere else: a folder, or a .md file for one session
overshare archive --all -o ~/notes/sessions
overshare archive --current -o today.md
```

Files go to `~/.local/share/overshare/archive` (`$XDG_DATA_HOME/overshare/archive`), unless config
`archive.dir`, `$OVERSHARE_ARCHIVE_DIR` or `-o` says otherwise. Each project gets a folder, and each file in it is
named `<start date>_<harness>_<project>_<id>.md`, for example `overshare/2026-10-24_claude-code_overshare_3f9c2a1e.md`.
The project is in the file name too, so a file copied out of its folder still says where it came from. Files are
readable only by you (mode 0600).

The project is the repository the session ran in, not just the last folder of its working directory: a session
started in `overshare/packages/core` is filed under `overshare`, and one in a git worktree under the repository the
worktree belongs to (the worktree's own folder name is kept in the frontmatter as `worktree`). A worktree that still
exists is followed back to its main checkout through git's own files. One that has been removed leaves nothing to
follow, so its path is read instead when it has a known layout: `…/worktrees/<repo>/<name>` (T3 Code, herdr),
`<repo>/.claude/worktrees/<name>` (Claude Code) and `~/.codex/worktrees/<id>/<repo>` (Codex). Otherwise the last
folder names it. A session with no working directory goes in `_no-project`. The folders in the archive are
overshare's: keep copies of your own somewhere else, since a run moves (and so removes) a session's file found in
any of them.

## Re-running

Run it as often as you like. A file whose session has not changed since it was written is skipped without
reading the session; a session that has grown since is written again. When a rewrite gives a session a different
name (its project now resolves differently, or a denylist entry redacts it), the old file is moved, not copied: the
output says `moved from <old name>`. A file left loose at the top of the archive (from before project folders) is
always rewritten into its folder. A name only changes on a rewrite: a file that is up to date keeps its name until
its session changes, or until `--overwrite`. Changing `--mode`
or `--tools` also rewrites a file, and so do changes to what redaction uses: the `redact` config (a new
denylist entry, say), the contents of a `--secrets-file`, `--leaf`, `--include-system-prompt`, and a new
overshare version. `--overwrite` rewrites every file regardless, and `--dry-run` lists what would be written and
writes nothing.

The check reads `source_mtime`, `source_size`, `mode`, `tools` and `settings` (a short hash of those other
settings, never their values) from the file's frontmatter. Known values read from the environment and `.env`
files are not part of it, so after adding a secret there, pass `--overwrite`. With `--no-frontmatter` there is
no such record, so a file counts as up to date when it is newer than its session file; pass `--overwrite` after
changing any option. Turning frontmatter off for files that have it does not remove it until they are rewritten.

## What a file looks like

````markdown
---
title: "Fix flaky retry test in publish/r2"
session_id: "3f9c2a1e-7b44-4c0e-9d1a-5e2f8c6b0a11"
harness: "claude-code"
mode: "minimal"
tools: false
settings: "5d41402abc4b"
project: "overshare"
cwd: "~/workspace/overshare"
branch: "fix/r2-retry"
machine: "devbox"
started_at: "2026-10-24T14:02:11.000Z"
last_activity_at: "2026-10-24T15:47:30.000Z"
exported_at: "2026-10-25T09:12:03.000Z"
overshare_version: "0.4.0"
source_path: "~/.claude/projects/-home-[user]-workspace-overshare/3f9c2a1e-7b44-4c0e-9d1a-5e2f8c6b0a11.jsonl"
source_mtime: "2026-10-24T15:47:30.120Z"
source_size: 482113
models: ["claude-opus-5-5"]
turns: 2
usage:
  input_tokens: 41210
  output_tokens: 18834
  cache_read_tokens: 2104332
  cache_write_tokens: 98110
  cost_usd: 4.12
  cost_estimated: true
redactions:
  secrets: 1
  suspicious: 0
---

# Fix flaky retry test in publish/r2

## User (Turn 1)

the r2 retry test fails \~1 in 5 runs. output:\
AssertionError: expected 2 calls, got 3

```text
    at tests/r2.test.ts:88:12
```

## Assistant (Turn 1)

The flake comes from the backoff timer…

### What I changed

…

## User (Turn 2) · `/review`

src/publish/r2.ts
````

- **Mode.** `minimal` by default: each prompt and the final reply of its turn. `--mode brief` keeps every reply
  of a turn (under one Assistant heading); `full` and `prompts` work too. See [Share modes](sharing.md#share-modes).
- **Tool lines.** Off by default. `--tools` adds one line per group of tool calls
  (`` _Tools: Read ×6, Bash ×4 (1 error) · edited `src/x.ts`_ ``), the commands in `brief` mode, subagent launches,
  and in `full` mode one line per call. Tool output and thinking are never written.
- **Headings.** One `#` title, then `## User (Turn N)` and `## Assistant (Turn N)`; turn numbers match
  `overshare browse` and the report. With `--mode full --include-system-prompt`, a `## System prompt` section
  comes first, each part of it a plain-text code block. Headings in a reply are moved down so its shallowest is
  `###`, keeping their relative depth; one that would go past `######` becomes bold text.
- **Prompts are shown as typed.** A prompt is plain text, so the file escapes what markdown would otherwise turn
  into markup: a line starting with `#` or `>`, `<Name>` (which would vanish as HTML), a stray `*`, `_` or `~`, a
  line of `-` or `=` under text. Line breaks are kept (as a trailing `\`), an indented block such as a pasted log
  becomes a code block, and lists, links, inline code, tables, fenced code and paired `*emphasis*` stay as they
  are. A fence left open in a prompt or a reply is closed where that message ends.
- **Frontmatter.** On by default; `--no-frontmatter` leaves it out. Every value is redacted like the rest of the
  file: home paths become `~`, the home folder in Claude Code's project folder names `-home-[user]-`, your username
  `[user]`; the denylist and known values apply too. `machine` (the hostname) is left out when `redact.hostname`
  is on. `usage` covers the session's own model calls, not its subagents'.

## Findings

Archiving does not stop on findings. Each file's line in the output says what was found in it, and the
frontmatter keeps the counts (`redactions.secrets`, `redactions.suspicious`), so you can search the archive later:

- **Redacted secrets** are written: the values are already replaced with `[REDACTED:<rule>]`.
- **Suspicious values** (medium-confidence matches that could not be redacted, still in the file) are written and
  listed at the end with their place in the session and the line numbers of the session file, so you can look.
  An allowlisted value is not reported again.
- **Blocked** sessions (the final re-scan found a known value or high-confidence secret in the result) are held
  back. `--force` writes them anyway.

An `--all` run also writes `_archive-report.md` in the folder, with the same summary as a table, and replaces it
on the next sweep. See [Redaction](redaction.md) for what each layer catches.

## Options

| Option | Meaning |
| --- | --- |
| `[session]`, `--current` | One session: a path, id or id prefix, or the current one ([as for `publish`](sharing.md)). |
| `-a, --all` | Every session whose last activity is within `--since`. Subagent transcripts are never archived on their own. |
| `--since <when>` | With `--all`: `7d`, `12h`, `2w` or a date. Default `30d`. Last activity is the session's last entry. |
| `-o, --output <path>` | A folder (created if missing), or a `.md` file for one session. |
| `-m, --mode <mode>` | `minimal` (default), `brief`, `full` or `prompts`. |
| `--tools` | Add tool, command and subagent lines. |
| `--no-frontmatter` | Leave out the YAML frontmatter. |
| `--overwrite` | Rewrite files that are up to date. |
| `--force` | Also write sessions the final re-scan blocked. |
| `--dry-run` | List what would happen; write nothing. |
| `--json` | Print the run summary as JSON on stdout. |
| `-q, --quiet` | Print only problems and the end summary. |
| `--harness`, `--leaf`, `--secrets-file`, `--include-system-prompt` | As for `export` and `publish`. |

Exit codes: `0` everything written or up to date, `1` an error (a session that could not be read is listed and the
rest are still archived), `2` a file written with suspicious values to review, `3` a session held back.
