---
id: ass-jgn2
status: closed
deps: []
links: [ass-iugy, ass-t3hc]
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


## Notes

**2026-10-03T23:44:44Z**

Done with a different mechanism than the ticket suggested (agreed beforehand): no provenance is carried through parseSession/projectSession/redactSession. After the final re-scan, each finding's value is looked up in the source transcript (and subagent files) by a matcher over decoded JSONL strings and keys (src/redact/source-lines.ts), so the line is exact, mode-independent, and never touches the payload. Scope: suspicious and blocked items in the CLI report/JSON and the browse dialog; known-secret hits (whole and fragment) now also carry location + lines; home-path is not located (its value is the home dir, on thousands of lines). Browse ShareReview gained an issues list so blocked items are shown. Lookups are lazy (a clean share never reads the source again) and capped at 50 findings per scan. Limit: a value that only exists after a transform is not in the source verbatim and is reported by turn/step alone. Side finding: transcript-supplied entry types leak into redaction.dropped keys (ass-t3hc).
