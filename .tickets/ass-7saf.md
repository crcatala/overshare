---
id: ass-7saf
status: open
deps: []
links: []
created: 2026-10-03T19:05:09Z
type: task
priority: 4
assignee: cc-vps
tags: [security, browse]
---
# Browse list shows the raw index title (prompt prefix); decide whether to mask it to match the preview pane

Context: ass-ahh1. The browse list title for a session with no recorded title is raw prompt text cut at 80 (src/sessions/summary.ts summarizeRaw, oneLine(asked, 80)). It is local display only, never published, and the index cache already stores raw prompt text for search, so it adds no new exposure.

## Design

DECISION (user, 2026-10-03): leave it raw for now. Rejected: redacting at index time with the full Redactor (needs known-secret harvesting during indexing, cached titles go stale when secrets change, and the cache still holds raw prompt text) and dropping the prompt-derived title from the list (list becomes much less useful). OPEN CHECK before doing anything: this was inferred from the code, not seen on screen. Run the browse UI on a fixture whose first prompt line holds a planted fake key and look at (1) the list row and (2) the preview/viewer pane. If the pane shows the prompt redacted but the list shows it raw, that is an inconsistency: then apply a cheap pattern-only mask at list render time (not at index time, so the cache and its invalidation are untouched; known values are not masked, accepted). If the pane is raw too, close this ticket as wont-fix with that note.

## Acceptance Criteria

Either: list matches the pane (pattern-only mask at render, with a test using planted fakes) or: closed as wont-fix with the observed pane behaviour recorded.

