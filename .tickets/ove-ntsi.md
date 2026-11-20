---
id: ove-ntsi
status: open
deps: [ove-nl3h]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 3
assignee: cc-vps
parent: ove-v5c6
tags: [harness, antigravity]
---
# Antigravity: enrich from the conversation .db (thinking tokens, call ids, sources)

Optional enrichment after the Antigravity MVP. Format notes: docs/harnesses/antigravity.md ("What only the SQLite files have").

- Read conversations/<id>.db read-only with node:sqlite and a small protobuf wire reader (no schema; see ccusage and xhluca/session-migrate).
- Per model response: thinking vs response output tokens (reasoning), cache writes (Claude models), base model id; tool-call ids to pair results exactly.
- Validate that steps match the transcript 1:1 by index; on any mismatch fall back to transcript-only and say so (never fail the share).
- Version-gate: unknown table layouts or step types are skipped, not guessed.
- Later, when samples exist: subagents via parent_conversation_id / parent_references (the "swarm" plugin).

