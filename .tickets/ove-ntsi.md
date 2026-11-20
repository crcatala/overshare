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
# Antigravity: more from the conversation .db (thinking tokens, cache writes, subagents)

Follow-up to the Antigravity MVP (ove-nl3h), which already opens the .db for the cwd and tool-call ids and brings the node:sqlite + protobuf reader. Format notes: docs/harnesses/antigravity.md ("What only the SQLite files have").

- Per model response: thinking vs response output tokens (reasoning), cache writes (Claude models), base model id from gen_metadata.
- Steps the transcript skipped (e.g. status 6): decide whether to show them (as cancelled tool results) from the .db.
- Any mismatch between the .db and the transcript: fall back to the transcript and say so (never fail the share).
- Version-gate: unknown table layouts or step types are skipped, not guessed.
- Later, when samples exist: subagents via parent_conversation_id / parent_references (the "swarm" plugin).

