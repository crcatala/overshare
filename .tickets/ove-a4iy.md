---
id: ove-a4iy
status: closed
deps: []
links: []
created: 2026-10-25T18:32:11Z
type: feature
priority: 2
assignee: cc-vps
tags: [cli, archive, markdown]
---
# Add an archive command that saves redacted sessions as local markdown

Add an `overshare archive` command that saves redacted sessions as markdown files on this machine, for a personal, greppable record of past sessions. It runs the same pipeline as `publish` (`prepareShare`: projection, redaction, the final re-scan), but nothing leaves the machine and nothing waits for confirmation: files are written, and a summary at the end says what each one contained so it can be reviewed afterwards.

Two forms:

- `overshare archive [session]` (same session selectors as `export`/`publish`: path, id or prefix, `--current`, `--harness`, `--leaf`)
- `overshare archive --all [--since 30d]` sweeps every session whose last activity is inside the window

The existing `export` command (JSON / standalone HTML, `-o` required, default mode `full`) is left unchanged; `archive` has different defaults, so it is a separate command rather than `export --format md`.

## Design

## Key decisions and rationale

**New `archive` command, not `export --format md`.** `export` requires `-o` and defaults to `full`; archive wants a default folder, `minimal`, a bulk form and skip/update semantics. Reusing `export` would mean defaults that change with the format. `--all` is a flag, not an `archive all` subcommand: `all` would collide with the `[session]` id-prefix argument.

**Default mode `minimal`, no new modes.** `minimal` is "the user prompt and the final assistant message of each turn", which is what the archive is for. `-m brief|full|prompts` still work. The markdown renderer decides how much of each projection to print; `modes.ts` is unchanged.

**Tool lines off by default; `--tools` turns them on.** Without it a turn is prompt plus answer only. With it, each collapsed tool group renders as one italic line (`_Tools: Read ×6, Bash ×4 (1 error) · edited \`src/x.ts\`_`) and, in `brief`, its one-line commands as a list; subagent launches render as `_Subagent: <type> — "<description>"_`. Full mode's individual tool steps render as one line each (name and summary); tool results and thinking are never rendered in markdown.

**Default folder `$XDG_DATA_HOME/overshare/archive`** (`~/.local/share/overshare/archive`), next to the XDG config dir the tool already uses. Overridden by config `archive.dir`, then by `-o`. `-o` ending in `.md` is a file (single session only); anything else is a directory (created if missing).

**Deterministic file names:** `<YYYY-MM-DD>_<harness>_<project-slug>_<id8>.md`. The date is the session's start date, not its last activity, so a session that keeps growing keeps its file name. Mode is not in the name: re-archiving in another mode replaces the file (the change of mode counts as a change, below).

**Re-export changed sessions by default.** Frontmatter records `source_mtime`, `source_size` and `mode`. An existing file whose values match the session file and the requested mode is skipped as up to date, before any parsing or redaction. Anything else is rewritten. `--overwrite` always rewrites. With `--no-frontmatter` there is nothing to compare, so the existing file's own mtime is compared with the session file's instead (the export is up to date when it is not older). Plain "skip if the file exists" was rejected: a session archived mid-work would never be updated.

**`--since` filters by last activity** (`endedAt`, else file mtime), the same rule as browse's `since:` filter, and accepts the same values (`7d`, `12h`, `2w`, an ISO date; `parseSince`). Default `30d`. Files are pre-filtered by mtime before parsing (mtime is never earlier than the last entry). Subagent/sidechain transcripts are never archived on their own (`listSessions` already excludes them).

**Findings never stop the run; a blocked session is held back.**

- Redacted secrets: written (the values are already replaced with `[REDACTED:<label>]`).
- Suspicious values (medium confidence, still in the text): written, and listed in the end summary with their source locations, so they can be inspected.
- Blocked (the final re-scan found an unredacted secret in the payload): not written by default, listed as held back; `--force` writes it anyway.

Every file's frontmatter records the counts (`redactions.secrets`, `redactions.suspicious`), so the archive can be searched later, not only the terminal output. Each run also writes `_archive-report.md` in the target folder (overwritten per run) with the same per-file summary.

**Frontmatter on by default; `--no-frontmatter` drops it.** Every value comes from the redacted session, or is put through the same Redactor (home path → `~`, Claude's path slug → `-home-[user]-…`, username → `[user]`). `machine` is the hostname, omitted when `redact.hostname` is on, so the frontmatter never puts back what redaction removed. Strings are written as JSON strings (valid YAML double-quoted scalars), so titles with `:` or quotes are safe.

Fields: `title`, `session_id`, `harness`, `harness_version` (when recorded), `mode`, `project`, `cwd`, `branch`, `machine`, `started_at`, `last_activity_at`, `exported_at`, `overshare_version`, `source_path`, `source_mtime`, `source_size`, `models`, `turns`, `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `cost_estimated`), `redactions` (`secrets`, `suspicious`). Absent values are left out, not written as null.

**Heading layout:** `# <title>`, then `## User (Turn N)` and `## Assistant (Turn N)` (no per-turn heading, no timestamps; the dates are in the frontmatter). A slash command goes in the heading: ``## User (Turn 2) · `/review` ``. Turn numbers are the session's turn index, so they match across modes; a turn with no user prompt only has an Assistant section. In `brief`/`full`, a turn's assistant messages are joined under one Assistant heading.

**User prompts: plain text, made safe for markdown.** What the user clearly meant as formatting is kept; what markdown would misread is neutralised. No other guessing (spotting an unindented log line and fencing it, say): escaping is safe, restructuring can change what a prompt appears to say.

- single line breaks are kept as hard breaks (trailing `\`, which formatters do not strip, unlike two spaces)
- a line starting with `#`, `>`, `=`/`-` underlines (setext) or a thematic break is escaped, so prompts never contain headings
- `<` before a tag-like word is escaped (`\<RetryPolicy>`), so it is not eaten as HTML
- a `*` or `_` that could open emphasis but is unpaired is escaped; paired `*x*`, `**x**` are kept; `_` inside a word is left alone (not emphasis in CommonMark)
- fenced code blocks are kept; one left open is closed at the end of the prompt
- an indented block (4+ spaces) becomes a ` ```text ` fence
- lists, links and inline code are kept
- images: `_(N images)_` after the text

**Assistant text: markdown as written, with headings re-levelled.** Headings are shifted so the shallowest one in the message becomes H3 (below the H2 role heading) and the relative structure is kept: a message using `##`/`###` gets H3/H4. A heading that would go past H6 becomes a bold paragraph (`**text**`); this only happens when a message uses more than four heading depths. Setext headings are converted to ATX first. Lines inside code fences are never touched. A fence left open is closed at the end of the message, so it cannot swallow the rest of the file.

**Fences around fences:** whenever the renderer writes a fence (indented-block conversion, closing an open fence), it uses one more backtick than the longest backtick run inside.

**Small events:** a compaction renders as `_— context compacted —_` (always, it explains a jump in the conversation).

**Files are written 0600** (the `writePrivate` helper `export` uses); directories created 0700.

**Exit codes** (stable for scripts): 0 everything written or up to date; 1 an error; 2 something written has suspicious values to review; 3 a blocked session was held back. Per-session errors (an unparseable file, `prompts` mode unavailable) do not stop `--all`: the session is listed as failed, and the run exits 1 at the end.

**Other flags:** `--dry-run` (list what would be written, updated, skipped; writes nothing), `--json` (the run summary as JSON on stdout), `-q/--quiet` (only the end summary), and the session options shared with export/publish (`--secrets-file`, `--include-system-prompt`, `--harness`).

## Implementation sketch

- `src/markdown.ts` (new, browser-safe, no Node imports): `renderMarkdown(session, { tools, frontmatter })`, plus the prompt-escaping and heading re-levelling helpers, each exported for unit tests.
- `src/archive.ts` (new): default dir, file naming, up-to-date check, the run loop over refs, the summary (terminal, `_archive-report.md`, JSON).
- `src/cli.ts`: the `archive` command; reuse `withSessionOptions`/`prepare` with default mode `minimal`.
- `src/config.ts`: optional `archive.dir`.
- docs: a section in docs/sharing.md (or a new docs/archive.md linked from README), README command list, CHANGELOG Unreleased.

## Acceptance Criteria

- [ ] `overshare archive <session>` writes `<date>_<harness>_<project>_<id8>.md` into `~/.local/share/overshare/archive` (or `$XDG_DATA_HOME/overshare/archive`), mode `minimal`, file 0600
- [ ] `-o file.md` writes that file; `-o dir` writes into the directory, creating it; `-o file.md` with `--all` is an error; config `archive.dir` changes the default
- [ ] `-m brief|full|prompts` work; `prompts` on a session that cannot use it fails that session with the existing message
- [ ] Headings: one `# title`; `## User (Turn N)` / `## Assistant (Turn N)`; slash command in the User heading; no timestamps; brief's several assistant messages share one heading
- [ ] Assistant headings re-levelled so the shallowest is H3; overflow past H6 becomes bold text; setext converted; nothing inside code fences changed; an unclosed fence is closed per message
- [ ] User prompts follow the escaping rules in the design; a test checks that rendering the output with `marked` yields no headings, HTML or emphasis that the prompt did not contain, and that line breaks are kept
- [ ] No tool lines by default; `--tools` adds tool-group lines (and brief's commands), subagent lines and full mode's per-tool lines
- [ ] Frontmatter has the listed fields, every one redacted (home → `~`, path slug → `-home-[user]-`, username → `[user]`), `machine` omitted when `redact.hostname` is on; it parses as YAML (test with a title containing `: "` and a newline); `--no-frontmatter` removes it
- [ ] `--all` archives sessions with last activity in the last 30 days by default; `--since 7d` / `--since 2026-10-01` change the window; `--harness` narrows it; subagent transcripts are not archived
- [ ] Re-running is a no-op when nothing changed (reported as up to date, no parse); a session that grew is rewritten; a different `-m` rewrites; `--overwrite` always rewrites; `--no-frontmatter` falls back to comparing file mtimes
- [ ] Redacted secrets and suspicious values do not stop writing; a blocked session is held back unless `--force`; frontmatter records the counts
- [ ] The end summary lists each session as written / updated / up to date / held back / failed with its counts, then a review section with suspicious locations; the same summary is written to `_archive-report.md`; `--json` prints it as JSON
- [ ] `--dry-run` writes nothing (no files, no directories, no report) and lists what would happen
- [ ] Exit codes 0 / 1 / 2 / 3 as specified
- [ ] Unit tests for the renderer and escaping, CLI tests for the command (temp `XDG_DATA_HOME`, fixture sessions), `npm run typecheck` and `npm test` pass
- [ ] Docs and CHANGELOG (Unreleased → Added) updated


## Notes

**2026-10-25T18:56:39Z**

Implemented on feat/archive-markdown. Changes from the design, all found while building and testing:
- _archive-report.md is written by --all runs only. With -o file.md it would have landed next to an arbitrary file, and a single-session run would have replaced the last sweep's report with one line.
- The report's session paths go through the same personal redaction as the frontmatter (it sits in the archive); the terminal shows real paths, to open them.
- Frontmatter also records tools: true|false, so changing --tools rewrites a file like changing --mode does.
- The id in a file name is the first 8 characters, except for UUIDv7 ids (pi), whose first 8 are a timestamp shared by sessions begun within about a minute; those use the last 8.
- A lone ~ in a prompt is escaped like a stray * or _: GFM strikes through ~a~, and emphasis can pair across the lines of one paragraph. Only ~~a~~ is kept.
- A plain line right after a list item in a prompt is indented to the item's content column: CommonMark allows it unindented, but marked ends the item, which left the hard-break backslash visible.
- A heading line in a list item's content is escaped too (1. > x is a quote inside a list).
The fast-check properties in tests/markdown.vitest.ts found the last four; they pass at 8000 runs.
