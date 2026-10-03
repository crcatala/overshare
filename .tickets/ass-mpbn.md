---
id: ass-mpbn
status: closed
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


## Notes

**2026-10-03T15:23:08Z**

Part (a) shipped on branch feat/ass-mpbn-async-index (PR pending): incremental, non-blocking first-run index. Part (b) REMAINS and this ticket stays open for it: async/cancellable Source.view and Source.review (worker threads or equivalent), loading states in the viewer and publish dialog, redaction scan off the main thread.

What (a) did: runBrowse no longer builds the index before the UI starts. IndexJob (src/sessions/index.ts) lists every session from the stat-only listing (cache hits as cached, the rest as 'pending' placeholder rows), reads changed files newest first in ~20 ms time slices (setImmediate between slices, one file is never split), notifies once per slice, saves the cache every >=2 s while reading and on stop() (quit, ctrl-c, crash via process exit handler). BrowserApp shows 'reading sessions n/total', keeps the selection on the same session as rows fill in, refuses enter/p on a row not yet read, and says search/repo filter cover only sessions read so far. INDEX_VERSION not bumped: the cache shape is unchanged (placeholders are never persisted).

Measurements (counts and timings only; real sessions in ~/.claude/projects + ~/.pi/agent/sessions, cold = empty AGENT_SHARE_INDEX, PTY 130x40, node dist build):
- Sessions: 505 (119 claude-code, 386 pi), 778 MB. listRefs (stat only) 7 ms.
- Index work itself is unchanged: cold 1.7 s, warm 11-17 ms. Largest single file read: 43 MB = 87 ms; per-file p50 1.1 ms, p99 40 ms.
- Time to first paint, cold: before 1828/1858/1852 ms; after 142/148/150 ms. Warm: before 135/139 ms; after 154/155 ms (same within noise).
- Key handling during cold indexing ('?' sent at 300 ms, time until the help box is visible): before 1532/1555/1550 ms (queued behind the whole index); after 15/16/72 ms. A key sent at 100 ms (before first paint) is handled at 132 ms after.
- Event-loop stall while indexing (5 ms timer lag): max 84-85 ms = the one largest file; the rest of the slices are ~20 ms. So worst-case key latency during the cold index is bounded by the largest single transcript. Reading that file on a worker thread would remove it; that belongs to (b).
- Quit mid-index keeps progress: a run killed by ctrl-c ~0.6 s into a cold index left a 125 KB cache (about a third of the sessions) that the next run reuses.
- Total cold index time is unchanged (~1.7 s); the list is usable from first paint instead of after it.

Known limitations of (a), not fixed here: a pi subagent-worker session shows as a normal row until it is read (the worker flag comes from the title); sort by title/prompts/calls/duration and the free-text/repo/branch/model/tool filters only see rows already read, so they reorder / fill in as reading proceeds.

**2026-10-03T16:41:55Z**

Decision (2026-10-03): part (b) will be done as its own follow-up PR on this ticket, not folded into the part (a) PR (#30). ass-mpbn stays open until (b) merges and is closed by that PR.

**2026-10-03T17:22:19Z**

Part (b) shipped on branch feat/ass-mpbn-async-view-review (PR pending). With (a) this completes the ticket.

Mechanism: one worker thread per request (node:worker_threads), not an async/chunked main-thread approach. Parse + project + redact + re-scan are single synchronous calls inside the adapters/pipeline, so they cannot be sliced without rewriting them; a worker needs no changes to them. Source.view(s, signal) and Source.review(s, mode, signal) are async and cancellable (abort = worker.terminate(), so the CPU work really stops). Code: src/browse/job.ts (the work, shared by worker and tests), worker.ts (entry), runner.ts (workerRunner / inlineRunner), source.ts (cache, shared in-flight scans, review ids). Works from src (tsx/vitest, loads tsx in the worker) and from dist (verified: built CLI opens and reviews a fixture session in a PTY).

Security shape: only plain data crosses the boundary (view, review = rule/length/location, payload bytes transferred not copied). Known secrets are collected inside the worker from the same config and env. Errors cross as SafeError with fixed text (prompts-unavailable keeps its own count message; fs errors keep the errno code only; everything else keeps only its class name); a worker crash/exit is a fixed 'background reader stopped unexpectedly'. Each review has an id and publish(s, mode, {reviewId}) uploads only that review's payload (also checked against the reviewed byte size), so what is on screen == what is uploaded even if a second scan of the same session/mode lands in between.

Measurements (counts and timings only; real sessions, 507 total, node dist build, 16 cores, 3 runs each; main-thread blocked time = longest gap between two event-loop turns, probed with a 1 ms timer):
- largest session 43.4 MB: open (view) before 139-144 ms blocked, after 1-2 ms (wall 175-189 ms). review full before 559-610, after 1-2 (wall 605-631). brief before 240-244, after 1-2 (wall 292-295). minimal before 201-206, after 1-2 (wall 247-251). prompts before 182, after 1-2 (wall 228-230).
- 33.7 MB: view 109 -> 1-2 ms; full 757-762 -> 1-2; brief 284-287 -> 1-2; minimal 204-207 -> 1-2; prompts 169-171 -> 1-2.
- 31.0 MB: view 91-93 -> 1-2; full 749-762 -> 1-2; brief 222-223 -> 1-2; minimal 169-170 -> 1-2; prompts 145-146 -> 1-2.
- median 0.5 MB pi session: view 2-4 ms -> 1-2 ms blocked, but wall time rises to ~37 ms (worker start-up, ~35 ms): small sessions open ~35 ms later than before, off the main thread. review brief 10-12 -> 55 ms wall.
- So the longest gap between two event-loop turns while loading dropped from 91-762 ms to 1-2 ms in every case (keypress latency during a load is now bounded by one render).
- PTY on a 35 MB FAKE fixture (130x40, built CLI, 3 runs): esc pressed 50 ms after opening a session is handled before 125-133 ms (main) vs 12-17 ms; a mode key pressed while a full-mode scan runs is handled after 8766-8797 ms (main; that fixture's full scan takes ~8.8 s) vs 4-6 ms. 'reading the session' is on screen 4-5 ms after enter before and 6 ms after.
- Not in scope, observed: scan cost scales with the number of strings and the payload, not only bytes (a synthetic 3.6k-turn session takes 4 s in brief and 24 s in full); it no longer blocks the UI and can be cancelled.

Found, out of scope: ass-ahh1 (a secret split by the 80-char title cut leaves a long prefix in session.title, pre-existing on main).
