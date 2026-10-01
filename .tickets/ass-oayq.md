---
id: ass-oayq
status: open
deps: []
links: [ass-azwt, ass-1rgj, ass-mpbn, ass-pifw]
created: 2026-10-01T01:15:35Z
type: task
priority: 3
assignee: cc-vps
tags: [browse, sessions, ux]
---
# browse: better titles for slash-command sessions and a hide-trivial filter

Follow-up from PR #21 (`agent-share browse`, follow-up item 5).

## Problem
1. **Weak titles.** `summarizeRaw` (`src/sessions/summary.ts`) uses the recorded title (`ai-title` / `custom-title` for Claude, `name` for pi) if present, else the first prompt that does not start with `/`, else `c.first`. Sessions that are *only* a slash command (`/model`, `/workflow:…`, `/clear`) end up titled with just the command, which says nothing about the session. For Claude, the command's real expansion follows as an `isMeta` line that the summarizer deliberately skips (see "A command's expansion follows it as a meta line (skipped above)" in `summarizeClaude`), so the useful text is thrown away.
2. **Trivial sessions are listed.** Sessions with no model calls (`calls === 0`), or that are only `/model` / `/clear` style housekeeping, show up in the list and search results. They are noise when looking for something to share. (Subagent worker sessions already have their own default-hidden filter: `workers:yes` in `src/sessions/query.ts`.)

## Why
The browser's whole job is "find an older session and share it". Titles are the primary scan target, and empty/housekeeping sessions dilute the list.

## Design notes
- Titles: when the title would be a bare slash command, derive a better one from the command's expanded text (the `isMeta` line right after it) or from the first real assistant/user content, keeping the command as a prefix is fine (e.g. `/review: <first line of expansion>`). Must stay a single-pass summarizer that does not JSON-parse tool results (performance is a design goal; see the header comment of `summary.ts`). Bump `INDEX_VERSION` in `src/sessions/index.ts` so stale cache entries are rebuilt.
- Hide trivial: add a `SessionSummary`-derived predicate (e.g. no model calls, or zero authored non-command prompts) and a query token `trivial:yes` that shows them, hidden by default, mirroring `workers:yes` (parse in `parseQuery`, applied in `matches`). Mention it in the `?` help and in the README "Browsing sessions" section next to `workers:yes`. Decide and document the exact definition of trivial; be conservative so a real short session is never hidden (e.g. a one-prompt session that got a reply is NOT trivial).
- Keep the footer/count text (`7/7`) consistent with hidden items, as workers are today.

## Acceptance
- A Claude session whose only prompt is `/model` (or other bare command) gets a meaningful title when expansion/other content exists, and still gets a sane fallback when nothing else exists; same for pi where applicable. Tests in `tests/sessions-index.vitest.ts` using `ClaudeTranscript` / `PiTranscript` helpers from `tests/helpers.ts`.
- Sessions with no model calls (and the documented definition of trivial) are hidden by default and shown with `trivial:yes`; non-trivial short sessions are not hidden; workers behaviour is unchanged. `query.ts` tests cover parse + match.
- `INDEX_VERSION` bumped; an old cache file is rebuilt, not misread.
- The browser UI (`tests/browse-app.vitest.ts` style) shows the hidden default and the token via search; help text and README updated; layout-invariant tests (`tests/browse-layout.vitest.ts`) still pass.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-10-01T03:16:31Z**

From the review of PR #21 (2026-10-01): the pi summarizer (`summarizePi` in src/sessions/summary.ts) takes stored user-message text verbatim and ignores the verified authored-input provenance entries that the pi adapter validates (`authoredInput` in src/adapters/pi.ts, PI_INPUT_PROVENANCE_TYPE). Sessions run through a pi prompt template therefore get the expanded template text as title, preview and search text, while the viewer (which uses the adapter) shows what the user typed. Local display/search only: shares are unaffected (the adapter and the prompts-mode refusal in src/modes.ts guard them). Fold into this ticket: for pi, use the authored input when the preceding custom entry binds to the message (same checks as the adapter: parentId, timestamp, sha256 of the stored content), else fall back to the stored text; reuse the adapter's validation rather than writing a second heuristic. Needs an INDEX_VERSION bump (shared with the title work).
