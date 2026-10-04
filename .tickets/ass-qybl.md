---
id: ass-qybl
status: open
deps: []
links: []
created: 2026-10-04T03:38:22Z
type: feature
priority: 2
assignee: cc-vps
tags: [redaction, security]
---
# redact: hand-written provider token-format table + strong-context rules

Betterleaks comparison (2026-10-03) showed the pattern layer (@sanity-labs/secret-scan, frozen Feb 2026) misses many prefix-anchored provider token formats (e.g. Google AIza, Slack xapp-, OpenRouter, GitLab runner/deploy tokens, Vercel, Supabase, Neon, Notion, ...) and that looksLikeSecret is too strict in strong-context rules (Authorization header, curl -H, curl -u). Add a hand-written format table (no code copied from betterleaks; it was used only as a checklist of which providers exist), strong-context tier, psw/_pw key names, curl -u, X-*-Key/Token headers, and AWS secret-near-key-id proximity.

## Acceptance Criteria

Bare tokens of each table format are redacted (high confidence) and blocked by the re-scan; look-alike identifiers/placeholders are untouched; curl -H/-u and psw/_pw cases redacted; tests plant runtime-assembled values only; README Redaction section updated.

