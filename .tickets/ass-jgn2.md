---
id: ass-jgn2
status: open
deps: []
links: [ass-iugy]
created: 2026-10-03T02:29:12Z
type: task
priority: 3
assignee: cc-vps
tags: [redaction, security, publish]
---
# redact: show source transcript line numbers for suspicious and blocked findings (phase 2 of ass-iugy)

Follow-up split out of ass-iugy. ass-iugy locates a suspicious (or blocked) value by turn number (1-based, as in agent-share browse), step/tool name and field path, plus the transcript path. Phase 2 is the source JSONL line number, so the user can jump straight to the line in the file.

Why not done there: the re-scan runs on the projected + redacted payload, not on the source file. Line numbers need provenance carried from parseSession (adapters in src/adapters/) through projectSession (src/modes.ts, which merges steps in brief/minimal mode) and redactSession into the payload walk in src/redact/rescan.ts (collectStrings). Steps are merged or dropped by mode, so a provenance field on Turn/Step (e.g. source line range) has to survive projection without being published (or be stripped before JSON.stringify of the share). pi sessions are tree-shaped JSONL (leafId), Claude Code adds subagent files, so the mapping differs per harness.

Acceptance: a suspicious/blocked item reports 'line N' (or a range) of the transcript file for JSONL harnesses; a multi-message fixture test checks it for Claude Code and pi in every share mode; the line info is never part of the published payload; locations stay value-free.

## Acceptance Criteria

Line numbers in report/JSON/browse for suspicious and blocked items, tested on multi-turn fixtures for both harnesses and all modes; not present in the published payload.

