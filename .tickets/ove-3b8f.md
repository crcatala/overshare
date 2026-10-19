---
id: ove-3b8f
status: open
deps: []
links: []
created: 2026-10-19T16:56:49Z
type: task
priority: 3
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, betterleaks]
---
# Vendor the Betterleaks rule file and a converter, not wired in

Phase 1 of ove-2q2x. Copy `config/betterleaks.toml` from a pinned Betterleaks release into `vendor/betterleaks/` with its LICENSE and `upstream.json` (tag, commit, sha256, date). Add `scripts/update-betterleaks.ts`, which converts it into `src/redact/betterleaks-rules.json`: id, regex rewritten for JavaScript, flags, lowercased keywords, value group, confidence, and an entropy threshold where a rule's filter is only that. No behaviour change: nothing imports the JSON yet.

## Design

- Accept both rule shapes (see the epic's v1/v2 note): `secretGroup` or `valueGroup`; `filter.entropy(…)` or `entropy(…)`.
- Strip `validate`, `analyze` and `revoke` entirely: `validate` sends the found secret to the provider's live API. A test checks no converted rule carries them.
- Regex: hoist a leading `(?i)` to the `i` flag; rewrite a mid-pattern `(?i)` by expanding what follows into case-insensitive character classes (`engines` allows Node 22.19, which has no `(?i:…)` modifiers); `(?P<name>` becomes `(?<name>`. At v2 rc, 441 of 465 regexes compile after the hoist alone; the other 24 need the rest. Any rule still not convertible is skipped and listed with the reason, in the converter's output and in the PR.
- Filters other than a lone entropy threshold are dropped, and the converter lists the rules that lost one. Most rely on `tokenRatio` (a cl100k BPE measure), which is not ported; `looksLikeSecret` plays that part for us.
- `--check`: converting the vendored file reproduces the committed JSON exactly, for CI.
- Pin the latest stable release when this starts (v1.9.0 as of 2026-10-19; v2.0.0-rc.2 is the newest pre-release).

## Acceptance Criteria

Every converted rule compiles on Node 22 and 24 (CI runs both); the skipped-rule and lost-filter lists are in the PR; `--check` runs in CI; no converted rule has validate, analyze or revoke; LICENSE and provenance are vendored.

