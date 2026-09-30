---
id: ass-zc54
status: closed
deps: []
links: [ass-75mx, ass-xz9u, ass-z5og, ass-5r99, ass-rc52, ass-cjrn]
created: 2026-09-30T14:55:28Z
type: task
priority: 2
assignee: cc-vps
tags: [claude-code, subagents, fixtures, tests]
---
# Subagent fixtures with cost-state cross-check (sanitized synthetic Claude sessions)

Sanitized synthetic Claude sessions that model the real on-disk layout, with the subagent files, plus the embedded ground truth to test against. Prerequisite for the adapter ticket's cross-check; the leak bug ticket uses inline builders and does not wait for this.

Source: throwaway repo ~/workspace/usage-sandbox, transcripts in ~/.claude/projects/-home-mog-workspace-usage-sandbox/ (all synthetic, safe to commit and screenshot). Claude Code 2.1.285. Sessions:
- 2b450029: 2 background subagents (`-p` mode), notifications in main
- 9150e1c1: 1 background subagent, interactive
- 491c3f9b: 1 foreground subagent (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1), tool_result carries totalTokens/usage
- 9a69feab: Sonnet 5.5 main, custom `reviewer` subagent on Haiku 4.5 (9 calls, 18 tool uses)
- bf3c7500: 3 parallel foreground subagents
- 2a10ef7b / edf2048e: Opus 5.5 fast vs standard (shared with ass-zr02 part 3)

## Scope
- Trim to fixtures under src/fixtures (or tests fixtures dir; follow existing convention): keep structure (main jsonl, `<session-id>/subagents/agent-*.jsonl` and `.meta.json`, cost-state line, task-notification user lines, `origin` fields); drop the large attachment/system-prompt payloads that carry no signal. Keep usage numbers unmodified so main+subagent totals still equal cost-state.
- Scrub local paths (output-file paths under /home/mog/.tmp, cwd) to neutral ones; check no tokens/keys/real content.
- A helper test that, for every fixture session, asserts unique-message-id usage summed over main + subagent files equals the fixture's cost-state numbers (this is the ground-truth invariant found in ass-rc52: it held in 6 of 7 sessions; 9150e1c1 was not reconciled, verify it here).
- Include one case of each launch shape: async_launched + notification, foreground with tool_result usage, parallel, mixed-model, and 5m vs 1h cache writes (subagent wrote 5m while main wrote 1h).

## Acceptance
- Fixtures load through the existing fixture/demo machinery without breaking `npm run demo`.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-09-30T15:43:00Z**

Shipped: 7 sanitized Claude 2.1.285 sessions in tests/fixtures/claude-subagents (layout mirrors ~/.claude/projects: main jsonl + <id>/subagents/agent-*.jsonl + .meta.json; 301 KB total, 27 files), scripts/sanitize-claude-fixtures.mjs to regenerate, tests/subagent-fixtures.ts (ground-truth helper: unique message.id usage over main+subagent files, cost-state totals) and tests/claude-subagent-fixtures.vitest.ts (31 tests). Invariant holds exactly (4 token fields, per model) in 6 of 7; 9150e1c1 (interactive background run) is NOT reconciled: cost-state exceeds the files by +1648 in / +890 out / +71616 cacheRead / +372 cacheWrite, pinned in the test, files never exceed cost-state; cause not established (likely unpersisted side calls). All seven show main writing 1h cache and subagents 5m. Launch shapes: async+notification (2b450029 x2, 9150e1c1), foreground with tool_result usage (491c3f9b, 9a69feab, 2a10ef7b, edf2048e), parallel (bf3c7500), mixed-model (9a69feab), fast vs standard (2a10ef7b/edf2048e). For ass-75mx: use tests/subagent-fixtures.ts (transcriptTotals/costStateTotals) as the cross-check; meta.json toolUseId links each file to its launching Agent tool_use in all 7 sessions; the raw dedupe rule is largest usage per message.id (streamed partials differ in subagent files, e.g. output 4 then 135).
