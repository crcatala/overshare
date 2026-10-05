# Browsing sessions (`overshare browse`)

An interactive browser for finding an older session and sharing it. It lists every local Claude Code and pi session
with a preview, filters and search, a two-pane session viewer, and a publish dialog that runs the same redaction
and final re-scan as `publish`. Needs an interactive terminal.

```bash
overshare browse                       # everything
overshare browse -q 'harness:pi since:7d refactor'   # start with a search
```

```
overshare  7/7
 harness: all   repo: all   time: any   shared: any   group: date   sort: default ↓
/ search  ·  harness:pi  since:7d  shared:no  tool:Bash  model:opus
── Today ─────────────────────────────────────────────── │ Fix invoice currency bug
▌1h ago     CC billing    Fix invoice currency bug     ✓  │ Claude Code · opus-5-5 · feat/money · 32m 0s
 3h ago     π  billing    Refactor money helpers          │ 9 prompts · 41 model calls · 878.9 KB
── Yesterday ─────────────────────────────────────────── │ Bash ×12 · Read ×7 · Edit ×3
 yesterday  CC web        Onboarding empty state          │
```

## Keys

| Key | Does | With Shift |
| --- | --- | --- |
| `j` `k` / arrows | move (`home`/`end`) | |
| `space` `b` | page down / up (also `PgDn`/`PgUp` and `ctrl-f`/`ctrl-b`; `ctrl-d`/`ctrl-u` move half a page) | |
| `/` | search: free words plus `harness:pi repo:x branch:y model:opus tool:Bash since:7d before:2026-09-01 shared:no workers:yes` | |
| `h` `r` `t` `s` | cycle harness · repo · time · shared | `H` `R` `T` `S`: pick from a dialog (`/` filters the repo list; a long list scrolls in a fixed 10-row window with a row of dots for your position, and `PgUp`/`PgDn` page it) |
| `g` | cycle grouping: none → date → repo → harness | `G`: dialog |
| `o` | cycle sort field (size, title, repo, prompts, calls, duration, updated); selects the first session | `O`: dialog with field and direction |
| `x` | clear search and filters (grouping and sort stay); shown in the footer while there is something to clear | |
| `ctrl-r` | refresh: list the sessions again and read the new and changed ones (a session still being written, a new one, a deleted one); the selection, search and filters stay | |
| `enter` | open the session viewer | |
| `p` | publish: mode → review → confirm (`enter` continues; only `y` publishes) | |
| `y` | copy the latest share link (terminal clipboard, OSC 52) and print it whole in the footer | |
| `,` | settings: confirm before quitting, date format | |
| `?` / `q` | help / clear filters, then quit (asks first unless you turned that off) | |

## Search

Free words must all appear (case-insensitive, any order) in the title, repo, branch, model or the
session's prompts (the first ~6,000 characters of them; replies and tool output are not searched). Wherever a word is on screen it
gets an amber background: in the repo, branch and title of a row, and in the preview. Most matches are in prompt text a row
has no room for, so while you search the preview also quotes the prompt each word was found in, under **matched in prompts**
(prompts the preview keeps are quoted as written; text only the search index has is lower-case). Words that only match the title,
repo or branch are not quoted again. Words of one letter still match but are not highlighted.

The filter chips under the title double as a key legend: the hotkey letter in each (**h**arness, **r**epo, **t**ime,
**s**hared, **g**roup, s**o**rt) is bold and underlined. Changing a filter, the search or the sort selects the first session again
and scrolls to it; grouping keeps the selection where it is.

## The session viewer

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

### Searching in the viewer

`/` searches the session's messages with the same rule as the list (free words, all in one message,
case-insensitive): the list narrows to the messages that hold them, with the number of hits each holds in the corner of its row
(`×3`), and every hit is highlighted in the list rows and in the content pane. `enter` or `↓` finishes typing, `esc` clears. Under
the header a line says how many messages match, and how many more would at other list levels (`+2 in hidden kinds (v)`) or in
tool output (`+4 in tool output (o)`). A tool call's or subagent's result is left out by default, because words like "error" or
"test" are in most of it; `o` includes it. `n`/`N` step to the next/previous hit: from the content pane a line at a time (the pane
scrolls to put the hit near the top), then message by message; from the list message by message. `x` clears the search.
Opening a session from a search in the list carries its words over: they are highlighted and the viewer starts on the first
message that holds them, but the list is **not** narrowed (so `esc` still leaves the viewer); `/` then starts a search of its own.

### Formatting and previews

The content pane formats what it shows: an assistant reply as markdown (headings, lists, tables, quotes, highlighted code
fences); a prompt as you typed it (not markdown); a `Bash` call as highlighted shell with its output below; an `Edit` (Claude
Code's, `MultiEdit`, or pi's `edit`) as a red/green diff with unchanged stretches collapsed; a `Write` as the file's code; any other tool as its JSON
input, then its result.

The list's preview also shows the **last reply** (the last thing the assistant said in words), and each session's **branch**: the one
the transcript recorded (Claude Code) or, where there is none (pi), a best guess marked `~` in the list and "(guess)" in the preview. The guess comes from the repo's own
files, with no `git` process: HEAD's reflog says which branch was checked out when the session ended, and a repo that never switched is on its
current branch. It is wrong when the reflog has expired (90 days), the branch was deleted or renamed, or the working directory is gone. The list
shows a branch column only when the terminal is wide enough to leave the titles room (about 140 columns); `branch:name` searches both kinds.

## Settings

Preferences live in `~/.config/overshare/browse.json` (`OVERSHARE_BROWSE_SETTINGS` overrides), separate from
`config.json` because the browser rewrites this file whenever you change one in the UI. A missing or invalid file, or
field, falls back to its default.

```json
{ "confirmQuit": true, "dateFormat": "relative", "viewer": { "indentReplies": false, "indentTools": false, "markers": "icon" } }
```

| Setting | Values | Where |
| --- | --- | --- |
| `confirmQuit` | `true` (default) asks "Quit overshare?" before leaving; `false` quits at once | `,` |
| `dateFormat` | `relative` (default, `5h ago`) · `smart` (`14:05` today, `Jul 14`, `2025-07-14`) · `short` (`Jul 14 14:05`) · `date` (`2026-07-14`) · `datetime` (`2026-07-14 14:05`); local time except relative | `,` |
| `viewer.indentReplies` | indent assistant replies one level under their prompt (default `false`) | `V` in a session |
| `viewer.indentTools` | indent tool calls, thinking, subagents and events one level deeper than replies (default `false`) | `V` in a session |
| `viewer.markers` | `icon` (default, `❯ ◆ ⚙ …`) or `text` (`[User] [Assistant] [Tool] [Thinking] [Subagent] [Skill] [Event]`) to mark each row of the message list | `V` in a session |

`ctrl-c` always quits immediately, without asking.

## How it works

- **Index.** Session summaries (title, repo, branch, models, first/last prompts, last reply, tool counts) are cached in
  `~/.cache/overshare/index.json` (`OVERSHARE_INDEX` overrides), keyed by path, mtime and size. The first run reads
  every transcript (a couple of seconds for ~500 sessions); later runs only `stat` the files. The list appears at once, with
  `reading…` rows that fill in (newest first) while a counter shows progress; keys work meanwhile, search and the repo filter
  cover only the sessions read so far, and a row cannot be opened or published until it has been read. The cache is saved
  as it goes, so quitting midway keeps what was read. The cache and `shares.json` are written
  readable by you only (0600), since they hold prompt text and unlisted share links.
- **Target.** The publish dialog names where the share goes, starting on your configured `target`; `t` switches between gist and R2 for
  that one publish (the config is never rewritten). A target that is not set up (no `r2` section, no credentials) is marked `✗`, says what
  is missing and cannot be published to. The review is made for the target on screen, so switching scans again and what you reviewed is what is uploaded there.
- **Shared marks.** Every successful `publish` (CLI or browser) is recorded in `~/.local/state/overshare/shares.json`
  (`OVERSHARE_SHARES` overrides). The browser shows a ✓ on those sessions and can filter by them. The preview and the
  session viewer's header show the latest link (cut in the middle when it does not fit) and how many earlier shares there are.
  OSC 52 asks the terminal to set the clipboard and nothing reports whether it did (macOS Terminal.app, and tmux without
  `set-clipboard on`, ignore it), so after `y` the footer prints the whole link to select by hand. The stored link is printed
  and copied without control characters or whitespace, so what you paste is what you saw.
- **What gets published.** The publish dialog reviews the chosen mode with the real pipeline and uploads exactly the payload you
  reviewed. Modes the pipeline refuses (for example `prompts` on a legacy pi session) say why and cannot be selected; a blocked
  re-scan cannot be published, and suspicious values (see [Suspicious values](redaction.md#suspicious-values)) need an extra confirmation first. The viewer itself shows your local transcript unredacted, because it never leaves your machine.
- **Terminal safety.** Errors inside the UI show in the footer instead of crashing; on any exit the terminal modes are restored.
  Transcript text is untrusted, so terminal control sequences in it (clipboard writes, title changes, screen clears) are stripped
  before anything is drawn.
- **Subagents.** Like `publish`, the browser reads a Claude session's subagent transcripts, so its viewer and reviewed payload match the CLI's.
