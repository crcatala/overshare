---
id: ass-cjrn
status: open
deps: []
links: [ass-75mx, ass-xz9u, ass-z5og, ass-5r99, ass-zc54, ass-rc52, ass-zr02]
created: 2026-09-30T14:55:28Z
type: bug
priority: 2
assignee: cc-vps
tags: [claude-code, subagents, tokens, viewer]
---
# Relabel or drop the Claude subagent usage chip (tool_result usage is last-call only)

Found in ass-rc52: for Claude foreground subagents the Agent tool_result carries `totalTokens`, `usage`, `totalToolUseCount` and `totalDurationMs`, but `totalTokens` and `usage` describe only the subagent's LAST model call (session 491c3f9b: totalTokens 14,419 vs 26,921 real; output 398 vs 537 real). `subagentUsageFrom` (src/adapters/shared.ts:138) surfaces them as the step chip, so Claude subagent chips undercount and imply totals. In background mode (the 2.1.285 default) the tool_result has no usage at all.

Small independent fix, shippable before the adapter ticket:
- For the Claude adapter, do not present tool_result totalTokens/usage as the subagent's total. Either drop those fields or label them "last call" until the adapter ticket replaces them with file-derived totals. `totalToolUseCount` and `totalDurationMs` look right (18 tool uses matched in session 9a69feab) and can stay.
- Leave pi behaviour unchanged (pi child totals come from `details.totalChildUsage`, whose semantics are unverified; best-effort per the ass-rc52 decision).
- Adjust tooltip/help text accordingly.

## Acceptance
- A test with a foreground-shaped tool_result asserts the chip no longer shows last-call figures as totals.
- Viewer tests, typecheck and build pass.

