---
id: ass-jn1t
status: open
deps: []
links: []
created: 2026-09-30T19:52:27Z
type: task
priority: 3
assignee: cc-vps
tags: [claude-code, tokens, investigation]
---
# Claude usage not in any transcript: main-file Warmup sidechain calls and interactive side calls

Found in ass-75mx. (1) 9 local sessions carry a sidechain-flagged user/assistant pair in the MAIN file (a 'Warmup' call on Haiku, ~1k input tokens, unique message id, no subagent file). The adapter drops it (dropped.sidechain) so it is in no total; ccusage counts sidechain entries. Decide whether to count it (likely an 'unlinked'-style bucket). (2) Both interactive (entrypoint cli) sessions with subagents (fixture 9150e1c1 and local 5faff187) have cost-state above everything the files show (5faff187: +10,026 input, +234 output, +107,662 cache read, +1,289 cache write) while all eight -p sessions reconcile exactly. A /btw probe on 2.1.286 wrote no transcript lines but its spend is in cost-state. Lead: interactive side calls (title, /btw, suggestions) are never persisted. Acceptance: a written finding; if a signal exists, model it; else keep the caveat in the cost tooltip.

