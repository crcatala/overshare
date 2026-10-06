# The viewer

The viewer is a static page (no backend) that fetches a share file in the browser and renders it.
The hosted copy is at <https://overshare.link/s/>; [self-hosting](self-hosting.md) covers running your own.

## Share links

The share location lives in the URL hash, which is never sent to the server:

| hash | source |
| --- | --- |
| `#owner/gistId` | `gist.githubusercontent.com` raw URL (no API rate limit) |
| `#gist:<id>` / `#<id>` | GitHub API (60 req/h per IP unauthenticated) |
| `#<source>:<id>` | a source from `viewer.config.json`, e.g. `#r2:<id>` |
| `#local:<name>` | file served by `overshare serve` |
| `#url:<path>` | same-origin path, e.g. `#url:examples/session.json` (the [example session](self-hosting.md#example-session)) |
| *(none)* | in a single-file HTML export, the session embedded in the page |
| `…&ui=log.brief.dark.L.toc-all` | open with these view settings (see [View settings](#view-settings)) |
| `…&turn=3` | open at prompt 3 |

## Format versions

Shares outlive the viewer that wrote them, and the viewer is always the latest build, so it reads
shares by the format version in them (`"schema": "overshare/N"`):

- **Same version**: shown as is.
- **Newer version** (shared with a newer overshare): shown best effort under a notice that names both
  formats, counts the parts it couldn't show and links to the first. Anything the viewer doesn't
  recognise, like a new kind of step, appears as a labelled placeholder instead of breaking the page;
  a turn that can't be read at all is replaced by a placeholder too.
- **Older version**: upgraded in the browser by small migrations (`viewer/src/compat.ts`), loaded only
  when a share needs one. A version with no migration says it can no longer be opened.

Adding optional fields never needs a new version. `src/schema.ts` says what does, and the shares frozen
in `tests/fixtures/shares/` keep every supported version rendering.

## Security

Transcripts are untrusted: anyone can make a gist and send a link to your viewer. The
header says where the share was loaded from (for gists, the owner as GitHub reports it)
and that the content isn't verified. Markdown is sanitized with DOMPurify and may not
carry classes (other than code-block languages), ids, form controls or dialogs, so it
can't imitate the viewer's own UI. Remote sources are dropped before anything renders:
images, video and audio show a "remote image not loaded (host)" note instead, and SVG
resource references (`<image>`, `<use>`, `url()` in `fill`, `mask`, `cursor`, …) are
removed. The CSP (checked against the real build by the tests) blocks scripts and remote
requests as a second layer.

## Layout

It reads like a terminal transcript: a centered mono column (640–840px depending on the
variant) you can scroll straight through. Each tool call is one line (`Bash(npm test)`,
`Edit(src/x.ts) +2 −1`) with a short preview of its output or diff under it; the full
input/output is built only when you open it. Brief/minimal shares show grouped work as
count badges (`Bash ×5 · Edit ×3`) with the files and commands involved. Code blocks and
output wrap instead of scrolling sideways, and markdown tables are drawn as text grids
that re-lay themselves out to the width (see [Text tables](#text-tables)).

Around the transcript, without pushing it off-center:

- **Contents rail** (left): one row per prompt with its time and tool count; "all" adds
  the replies, tool runs and events inside each turn. Filter with `/`, click to jump; the
  turn in view is highlighted.
- **Token rail** (right): session totals; a *Cache* list of [cache misses](#cache-misses);
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

## How the token rail counts

Totals cover the model calls on the branch being shown,
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

### Subagents

For Claude Code the rail's Session figures are labelled *main conversation*, and a
separate *Subagents* section gives what the subagents cost on their own: how many, *tokens
processed*, *est. cost* and *model calls*, read from their transcripts (hover the cost for the
split by model). Subagents no step on the shown branch launched (a forked skill, a rewound
branch) are a *not launched here* row, never folded into either figure. The header fact reads
`subagents: 3 (~$0.03)`. Each subagent's own tokens and cost are on its step (open it for the
split by token class and the model), and the turn that launched it, even when it finished
later, shows what its subagents used in the turn box and footer. They are not drawn in
*Context by turn* (a subagent has its own context window) and not in the cache figures. pi
keeps its best-effort chip and no subagent totals.

### Cache misses

The rail's *cache hit (tokens)* is the share of prompt tokens read from
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

## Keys and narrow screens

Both rails collapse (`«`/`»`, or `[` and `]`). When the window is too narrow to fit them beside the column they become overlays opened from the
minibar or the corner buttons. Keys: `j`/`k` next/previous prompt, `[`/`]` rails, `/`
filter the contents, `v`/`V` cycle design variants.

## Design variants

Three looks share one DOM, for picking a direction. Pick one from the
settings menu (the sliders icon next to the theme toggle), with `v`/`V`, or with
`&ui=<variant>` in the link:

| variant | look |
| --- | --- |
| `classic` (default) | After pi's session export: one text edge, prompts and tool calls as tinted blocks (different tints), a bold `$ command` over its output, thinking in dim italics; warm cli/gruvbox palette. |
| `cli` | The agent's own terminal: `❯` prompts on a faint band, `●` tool lines with `└` output, markdown shown with its `##` markers, rounded tables, floating rail panels. |
| `log` | A TUI log: `time │ role │ text` rows, framed panes with titles set into the border, a statusline and plain ASCII tables (gruvbox). |

## View settings

How a session is shown — variant, view (full/brief/minimal/prompts), theme,
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

## Text tables

Markdown tables become box-drawn grids sized in characters: columns
keep their longest word where possible, spare width goes to the columns with the most
body text (so a long header wraps before a long cell), emoji/CJK count as two columns,
and when even whole words can't fit, rows are shown as stacked `header  value` records.
The grid redraws when its container changes width; the original table stays in the DOM,
visually hidden, for screen readers. Inline code, emphasis and links are kept.

## Fonts

The viewer bundles its font (no font CDN): a subset of JetBrains Mono that
includes box-drawing, block and geometric characters — the stock web subsets leave box
drawing out, and text tables only line up when every character comes from one font.
The CSP allows `font-src 'self'`. It is under the SIL Open
Font License 1.1; the build writes its license to `s/font-licenses.txt` and into every single-file HTML export
(`viewer/font-licenses.mjs`).

## Running it locally

`overshare serve share.json` serves the viewer and the given share files (each opens as
`#local:<name>`); opening the viewer without a share in the link lists them in a picker.
`overshare demo` does the same with freshly generated fake sessions.

`serve` (and `demo`) listen on 127.0.0.1:3000 by default, so only this machine can
reach them. `--host 0.0.0.0` exposes them on your network (e.g. to open the viewer from
another device), and `--port` picks the port. If the port is taken it tries 3001, 3002, …
(up to 20 ports); `--strict-port` fails instead. The server hands the viewer and any share
files you pass it — only redacted exports — to anyone who can reach the port.

It answers only to requests addressed to `localhost`, an IP address or the `--host` value, so a
web page you visit can't point its own domain at 127.0.0.1 (DNS rebinding) and read the shares.
To open it by another name, such as a LAN or Tailscale hostname, pass `--allowed-host <name>`
(repeatable).
