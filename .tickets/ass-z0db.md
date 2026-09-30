---
id: ass-z0db
status: closed
deps: []
links: []
created: 2026-09-30T00:06:47Z
type: feature
priority: 2
assignee: cc-vps
---
# Add prompts-only shares and a variant-aware view menu

Strip non-user content before upload; retain per-turn numeric activity summaries. Replace full/brief/minimal buttons with a compact four-mode menu. Verify all variants and attach screenshots to the PR.


## Notes

**2026-09-30T00:26:26Z**

Implemented prompts projection before redaction/upload, optional numeric per-turn activity with legacy-share fallback, compact non-expandable summaries and four-mode dropdown in both headers. 467 tests pass, typecheck/build/diff checks pass. Browser QA: all five variants in light/dark at 1440px/390px, sticky mobile menus and 320px spot check; Claude and pi fixtures, mode switching, keyboard focus and reload. Scoped axe audits have zero violations; only decorative caret/check glyphs require manual review. Screenshots captured for PR attachment.
