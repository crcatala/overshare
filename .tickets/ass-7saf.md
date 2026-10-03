---
id: ass-7saf
status: closed
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


## Notes

**2026-10-03T23:09:35Z**

Observed (planted fake anthropic key straddling the 80-char title cut, real BrowserApp over the real Source, temp dir, terminal width 130 and 250). Counts of 12-char key windows visible: list row col = 0 at 130 cols (title column is ~40 chars, cut before the key starts), 35 at 250 cols; always-on preview column (title + first prompt, wrapped) = 86 at 130 / 96 at 250; viewer pane = 86; full key printed = false everywhere; redaction marker present = false in all three. So the preview column and the viewer both show the raw prompt (by design, src/browse/source.ts view is unredacted: the user's own machine). No inconsistency between list and pane => no code change. Closed wont-fix per the ticket decision. Masking only the list row would leave the preview column and viewer raw anyway.
