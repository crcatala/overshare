---
id: ass-yyg0
status: open
deps: []
links: []
created: 2026-10-03T19:33:17Z
type: bug
priority: 1
assignee: cc-vps
tags: [security, redaction]
---
# Secret prefix survives the 4000-char cut of a background subagent's final answer (boundedResult, adapter cuts before redaction)

Same class as ass-ahh1 and ass-7x3c, found while fixing ass-7x3c (out of its scope). src/adapters/shared.ts boundedResult cuts the subagent answer at SUBAGENT_RESULT_CHARS (4000) in the adapter, BEFORE redaction, for completeSubagent (task-notification answers) and setSubagentSummary (final message of the subagent's own transcript). A secret straddling char 4000 leaves an unmatched prefix in SubagentStep.result.text in full mode; report.blocked stays false. Fix direction as in ass-7x3c: the adapter keeps the answer whole and the pipeline caps it after redaction (cutPoint from src/cap.ts never splits a [REDACTED:..] token); measure/consider the memory cost of keeping whole answers. Needs a regression test per entry point in full mode for both adapters, shaped like tests/truncate-before-redact.vitest.ts.

## Acceptance Criteria

No fragment of a planted secret in the payload or any report string when it straddles the subagent answer cut; existing leak/own-fields/suspicious/truncate-before-redact tests unchanged.

