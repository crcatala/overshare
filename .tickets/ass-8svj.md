---
id: ass-8svj
status: closed
deps: []
links: []
created: 2026-09-30T19:52:27Z
type: bug
priority: 2
assignee: cc-vps
tags: [claude-code, adapters]
---
# Claude adapter drops sibling tool results of parallel tool calls

Found in ass-75mx. Claude Code chains the results of parallel tool calls as siblings (each result's parent is its own tool_use line, so the assistant line has two children). branchEntries follows one parent chain from the leaf, so all but one result of a parallel batch are off-branch and the step shows no result. Reproduced on the bf3c7500 fixture (3 parallel Agent launches: 2 of 3 steps had no result before ass-75mx filled them from the subagent file). Local corpus: 91 of 6026 tool calls have no result, in 14 of 94 sessions (some may be genuinely interrupted). Fix: attach tool_results by tool_use_id from any line whose tool_use is on the branch, instead of only lines on the parent chain. Acceptance: a test with a parallel batch; corpus count of resultless calls drops; other-branch usage unchanged.


## Notes

**2026-10-01T22:11:22Z**

Fixed: branchEntries now re-adds tool_result lines that answer a tool_use on the branch but hang off it as siblings (withSiblingToolResults in src/adapters/claude-code.ts). Local corpus: resultless calls 103/6362 (33 sessions) -> 1/6364 (1 session); responses, tool calls and token totals unchanged over 109 sessions.
