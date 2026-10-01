---
id: ass-gnso
status: open
deps: []
links: []
created: 2026-10-01T21:13:55Z
type: feature
priority: 3
assignee: cc-vps
tags: [browse, index]
---
# browse: refresh key for sessions that are still running

Follow-up from PR #21 (follow-up item 6).

## Problem
The browser builds its list once at launch (src/sessions/index.ts buildIndex, keyed by path + mtime + size). A session still being written keeps its old summary (title, prompt counts, size) until the next launch, so the list, preview and the viewer header can be stale while you keep working in another terminal.

## Design notes
- Add a refresh key (e.g. ctrl-r or R-less lowercase, check collisions with h r t s g o x) that re-runs the incremental index (only new or changed transcripts are re-read, so it is cheap) and keeps selection on the same session, like filter changes already do.
- Reuse the refresh progress reporting; if ass-mpbn (async index) lands first, build on it so refresh does not freeze the UI.
- Note: Source.review/publish cache by path|mtime|size|mode, so a refreshed session naturally gets a fresh review.

## Acceptance
- Pressing the key picks up appended messages, new sessions and updated titles without leaving the browser; selection and filters are preserved; footer/help list the key.
- Tests drive BrowserApp with the fake Source (tests/browse-helpers.ts): refresh updates rows, retains selection, handles a session that vanished.
- npm test, npm run typecheck, npm run build pass.

