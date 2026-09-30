---
id: ass-cjrn
status: closed
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


## Notes

**2026-09-30T19:52:36Z**

Shipped with ass-75mx on feat/subagent-usage. Claude adapter no longer uses tool_result totalTokens/usage (last call only); toolUses and durationMs kept; pi unchanged. Shares made before this still carry the last-call figure, so the viewer labels it '(last call)' for claude-code steps without source: transcript. Tests: adapter (foreground-shaped tool_result) and 4 viewer chip tests.

**2026-09-30T20:06:59Z**

DECISION (2026-09-30, with the user): no compatibility or migration code for our own old output. The repo is a private personal tool and not public yet, so breaking changes are fine; the way to make one is to bump SCHEMA_VERSION (the viewer already rejects a mismatched schema). Removed on feat/subagent-usage: the viewer's '(last call)' label and SubagentUsage.source (both existed only for shares made before subagent transcripts were read), and fixtureSharesCurrent (vite dev server now regenerates fixtures-out on every start). KEPT on purpose: tolerance for formats other tools write (Claude Code/pi transcripts on disk, which cannot be regenerated): origin absent = human, growing streamed usage snapshots (still present in 2.1.285), subagent meta/layout tolerance, LEGACY_PRICES, and pi's fail-closed prompts check (a privacy guard, not a migration). Rule of thumb: code that converts or special-cases our own old output is removed; code that parses someone else's files or refuses unsafe input stays. Consequence: shares made before this change show Claude subagent last-call tokens as a plain total; accepted. Effect here: the ass-cjrn fix is adapter-only (Claude tool_result totalTokens/usage no longer read); the viewer label was dropped.
