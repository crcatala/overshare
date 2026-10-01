---
id: ass-mpbn
status: open
deps: []
links: [ass-azwt, ass-1rgj, ass-oayq, ass-pifw]
created: 2026-10-01T01:15:13Z
type: task
priority: 2
assignee: cc-vps
tags: [browse, performance]
---
# browse: stop freezing the UI (first-run index, opening big sessions, redaction scan)

Follow-up from PR #21 (`agent-share browse`, follow-up item 1). Biggest usability rough edge of the browser.

## Problem
Everything heavy runs synchronously on the event loop, so the UI freezes (keypresses queue; nothing is lost, but nothing paints either):
1. **First-run index**: `runBrowse` (`src/browse/index.ts`) calls `buildIndex` (`src/sessions/index.ts`) before the UI starts. It reads every transcript once (`summarizeFile`), ~5 s cold for ~500 sessions (~60 ms warm, cache is a JSON file keyed by path+mtime+size). Today it only prints `indexing sessions… n/total` on stderr and the list appears at the end.
2. **Opening a session**: `Source.view` -> `loadView` (`src/browse/source.ts`) does `readFileSync` + `parseSession` on the main thread: 0.3–1.1 s on a 37 MB transcript.
3. **Review / publish scan**: `Source.review` -> `prepare` -> `prepareShare` (parse + project + redact + re-scan) is also synchronous, and runs as a second pass over the same file after the viewer parse.

## Why
Browsing is meant to be instant (a cursor move + redraw is ~12–15 ms by design; the lesson of the PR was "format only the visible rows"). Multi-second stalls on first run or on a large session make the tool feel hung, especially since there is no spinner while it is blocked.

## Design notes (suggested; pick the simplest that meets the criteria)
- **Incremental, async index**: paint the list from the stat-only `listRefs` right away (already exposed for this: "Stat-only listing (instant)" in `src/sessions/index.ts`), then fill in summaries as they are produced and re-render, persisting the cache at the end (and ideally periodically so a quit mid-index keeps progress). Rows not yet summarized need a placeholder (id/mtime/size/harness are known from the stat).
- **Worker thread** (`node:worker_threads`) for `summarizeFile`, `loadView` and `prepareShare` (these are pure functions of file contents + config), with results posted back. `Source` is already an interface (`view` / `review` / `publish`); making `view` and `review` return promises (with a loading state in the viewer and the publish dialog) is the natural seam. Keep `Source.review`'s cache semantic: **what is reviewed is exactly what is uploaded** (`publish` uses the cached prepared payload; there is a test that edits the file in between — it must keep passing).
- The tests drive `BrowserApp` with raw key bytes against a fake `Source` and fake timers; keep that style. Layout invariants (every line within terminal width, frame height exact) must keep holding for the new loading states.
- If the worker approach is too big for one PR, split: (a) incremental async index, (b) async view/review. Note in the ticket which part shipped.
- Related: ticket ass-azwt (cache known secrets) removes ~0.4 s per scan and is a separate, smaller change; do not block on it.

## Acceptance
- On a cold cache (delete the index file or point `AGENT_SHARE_INDEX` at an empty path) with hundreds of sessions, the list UI appears immediately (well under a second) and populates as indexing proceeds, with a visible progress indicator; keys work (move/search/quit) while indexing runs.
- Opening a ~30+ MB session shows a loading state immediately and the UI keeps redrawing/accepting `esc`/`q` while it parses (pressing esc cancels the open or at least returns to the list without a stale result being shown later).
- Opening the publish dialog / changing mode does not block key handling during the scan; the confirm step still cannot be reached before the review result for the *current* mode has arrived (debounce/staleness behaviour covered by existing flow tests must stay correct).
- The reviewed==uploaded guarantee and the nothing-sent-before-explicit-`y` behaviour are preserved (existing tests in `tests/browse-flow.vitest.ts`, `tests/browse-source.vitest.ts` still pass or are updated with equivalent assertions).
- Terminal restore on any exit (`emergencyRestore`, `runScreen` in `src/browse/kit.ts`) still works, including when a worker throws or exits.
- Measured before/after numbers (cold index time-to-first-paint, time-to-first-key-response on a large session) are recorded in a ticket note.
- `npm test`, `npm run typecheck`, `npm run build` pass.

