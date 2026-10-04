---
id: ass-qybl
status: closed
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


## Notes

**2026-10-04T04:17:19Z**

Done: src/redact/token-formats.ts (about 60 hand-written prefix formats + AWS secret near key id), looksLikeCredential strong-context tier (auth headers, curl -u), psw/_pw key names, resolveOverlaps tie-break to higher confidence, README. Measured on 300 real sessions: no new false positives after tightening (camelCase/readable-word rejection). Not done by design: login(user, "pw") call form, payments/commerce providers with niche formats (Flutterwave, Paddle, EasyPost, ...), betterleaks as an engine. Follow-ups: add LICENSE file; check sanity-labs/secret-scan's claim that TruffleHog is Apache 2.0 (GitHub reports AGPL-3.0).
