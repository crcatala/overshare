---
id: ove-v5c6
status: open
deps: []
links: [ass-zl0d, ass-6jd4]
created: 2026-11-20T18:20:21Z
type: epic
priority: 2
assignee: cc-vps
tags: [harness, codex, antigravity]
---
# Support Codex and Antigravity sessions

## Decision
2026-11-20: the user reversed the earlier "Claude Code and pi only" decision (ass-zl0d, ass-6jd4). OpenAI Codex and Google Antigravity become first-class harnesses, built in-tree through the harness registry.

## Research
- docs/harnesses/codex.md: rollout layout, line kinds, the two copies of each turn, code-mode tools, token semantics, subagents, what to drop.
- docs/harnesses/antigravity.md: data folders (incl. T3 Code's), transcript_full.jsonl, what only the SQLite files have, token semantics.
Both formats are undocumented and drift between versions: every adapter skips unknown line types and every new shape gets a synthetic fixture (no real transcripts in the repo).

## Phasing (one PR per child ticket, in this order)
1. Prices for OpenAI and Gemini models (shared prerequisite, no harness code).
2. Codex: current rollouts. First usable harness; settles the interface changes both harnesses need.
3. Codex: subagents, compaction, .jsonl.zst, continuation files.
4. Antigravity: transcript_full.jsonl + summary index.
5. Antigravity: enrichment from the conversation .db.
6. Codex: legacy history mode (only if someone has such files).
7. Demo fixtures for both.

## Why several PRs, not one
- Each harness PR is a parser of untrusted, undocumented input feeding the redaction and publish path. Reviewing one parser at a time with its own fixtures is how that stays safe; a single ~4-5k line PR would not get a careful read.
- Each MVP PR must be complete end to end (list, browse, --current, report, publish): a half-registered harness would appear in list/browse and then fail. So the cut is per usable capability, not per layer.
- Codex goes first: 62 local samples, closest to the existing JSONL harnesses. It also introduces the interface changes (sessions not grouped by cwd folder; extra files read beside the transcript) that Antigravity then reuses instead of a second, competing change.
- Prices are a separate PR because they touch cache-miss classification for every harness (src/cache.ts treats any priced model as an explicit, Anthropic-style cache), and that change deserves its own tests and review.
- Later PRs (subagents, .db enrichment, legacy) can ship or wait without blocking a working harness.

