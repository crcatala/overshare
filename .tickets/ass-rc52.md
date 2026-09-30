---
id: ass-rc52
status: closed
deps: []
links: [ass-lq0c, ass-jx4l, ass-75mx, ass-xz9u, ass-z5og, ass-5r99, ass-zc54, ass-cjrn]
created: 2026-09-30T02:18:33Z
type: feature
priority: 3
assignee: cc-vps
tags: [viewer, tokens, claude-code, subagents, investigation]
---
# Investigate Claude subagent usage: upload, totals and viewer (needs planning)

## Status: needs investigation and planning before implementation

This ticket is a starting point, not a spec. The first deliverable is a short written investigation (findings + proposed design + cost/privacy tradeoffs), then a follow-up implementation plan or tickets. Do not start coding from this description.

## Context

The 2026-09-29 token audit found that Claude Code subagent (sidechain) usage is not counted anywhere in our numbers, and this ticket also covers how such sessions are uploaded and shown.

What we know:
- Claude Code writes subagent transcripts as separate files next to the main one: `~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl` (plus `.meta.json`, and `.forked-skill*.json` for forked skills). Lines carry `isSidechain: true` and their own `message.id` usage. Our adapter parses only the main `<session-id>.jsonl` and drops sidechain lines (`dropped.sidechain`).
- The main transcript's Agent/Task `tool_result` sometimes carries structured usage (`totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage`) which we already surface as a chip on the subagent step (`subagentUsageFrom`), but never add to totals. (None of the local sessions had this shape; verify against current Claude Code versions.)
- Claude Code's `cost-state` `modelUsage` INCLUDES subagent spend. Example: local session 5faff187 (a forked skill): main transcript 1,131 output tokens; the subagent file adds 8,420 output tokens over 3 calls; `cost-state` output is 9,785. So today cost (if taken from `cost-state`) and tokens describe different populations. PR 1 of the token-accuracy work moves cost to a per-response estimate from the main transcript and labels the scope "main conversation only"; this ticket removes that caveat.
- pi has its own subagent model (`subagent` tool, child usage in tool result `details.totalChildUsage` / `usage`, `custom_message` events with customType `subagent*`); the adapter already extracts `SubagentStep.usage` from tool-result details. Check whether pi children write separate session files and whether totals should include them.
- ccusage includes sidechain entries in Claude totals and prefers the non-sidechain copy when a message id appears in both (it also guards against `/btw` sidechain logs replaying parent messages under new request ids).
- Locally subagents are rare (1 subagent file among 78 Claude sessions), so the dev corpus is thin: generate or find more realistic samples (e.g. agent-heavy sessions from other machines or synthetic fixtures modeled on the real file layout).

## Questions to answer

1. Upload: do we read and publish the subagent files (redaction, size, share modes), or only their numeric usage? The current pipeline takes one transcript path. What does `resolve.ts`/`--current` need to find them? What does a share of a session with 20 subagents weigh?
2. Numbers: how do subagent tokens and cost fold into session totals, per-turn charts and cache-miss detection? Probably shown as a separate line ("main" vs "subagents") rather than mixed into the context chart, because a subagent's context is not the main context window.
3. Viewer: what, if anything, do we show of a subagent's transcript (expandable inside the launching step? just usage?), and how does the rail attribute its tokens to the turn that launched it?
4. Dedupe: replayed parent messages in sidechain logs, async/background subagents finishing after the turn, and subagents whose tool result carries usage that also appears in the sidechain file (do not double count).
5. Privacy: subagent prompts and outputs can contain everything the main transcript can; redaction and share-mode projection (brief/minimal/prompts) must apply the same way.
6. Cross-check plan: use `cost-state` and ccusage output as ground truth for the totals.

## Deliverable of the investigation

A short design note (as a ticket note or a doc in the repo) with a recommended approach, the schema additions it implies, the fixture strategy, and a proposed breakdown into implementation tickets. Depends on the accuracy ticket (PR 1) being merged for the schema and cost machinery; relates to the cache-miss ticket (PR 2) for whether subagent cache behavior is in scope (Claude Code's own "Prompt cache (main)" line excludes subagents).


## Notes

**2026-09-30T14:38:38Z**

Investigation data + recommendations (2026-09-30). Generated 5 synthetic Claude sessions on Claude Code 2.1.285 in a throwaway repo (~/workspace/usage-sandbox; transcripts in ~/.claude/projects/-home-mog-workspace-usage-sandbox/, all synthetic, safe as fixtures/screenshots), plus 2 Opus 5.5 sessions (see ass-zr02). Shapes covered: 2 background subagents (-p), 1 background (interactive tmux), 1 foreground, custom agent on a different model than main (sonnet main, haiku subagent, 9 calls/18 tool uses), 3 parallel foreground.

FINDINGS
1. Ground truth reconciles exactly: sum of unique message.id usage across main + subagents/*.jsonl == cost-state modelUsage on all four token fields, in 6 of the 7 sessions (all except the interactive background run 9150e1c1, not reconciled), incl. the mixed-model one. Zero message-id overlap between main and subagent files; every subagent line has isSidechain:true.
2. The Agent tool_result usage is NOT a total. Foreground shape carries {status:completed, totalTokens, totalDurationMs, totalToolUseCount, usage, toolStats, resolvedModel}, but usage/totalTokens describe only the subagent's LAST call (run 491c3f9b: totalTokens 14,419 vs real 26,921; output 398 vs 537). Our subagentUsageFrom (src/adapters/shared.ts:138) surfaces that as the step chip, so it undercounts and is mislabeled for Claude today. Do not use it for totals; re-label or drop for Claude.
3. In 2.1.285 subagents are BACKGROUND by default, even interactively: tool_result is only {status:async_launched, agentId, outputFile}, no usage at all; completion arrives as a <task-notification> (queue-operation + user message, origin kind task-notification) whose <usage><subagent_tokens> is again a partial figure (14,150 vs 26,432 actual). The notification text says it can fire more than once per agent (not observed); completions landed after the launching turn's text. Foreground needs CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (meta.json requestShape says which). Conclusion: for current Claude Code the ONLY reliable source of subagent numbers is the subagent files. Real sessions will be mostly async_launched.
4. Subagent cache writes were ephemeral_5m while the main session wrote 1h (subagent runs on a different TTL). Extra-cost / TTL logic must not assume one TTL per session; use cache_creation.ephemeral_*.
5. Each subagent file is ~113 KB for a one-line task (system prompt + attachments dominate). 20 subagents ~ 2+ MB before any real work.
6. Subagent context is its own window (first call 0 cache read, then grows), so it must not be plotted on the main context chart or fed to main cache-miss detection (matches Claude Code's "Prompt cache (main)" excluding subagents).
7. pi: 14 local sessions have totalChildUsage in tool results, 16 have custom_message subagent*; children write only .md artifacts (subagent-artifacts/), no child session .jsonl seen. Not verified against the pi-subagents package source.

RECOMMENDATIONS
A. pi: do NOT add subagent support beyond today's best-effort chip. pi-subagents is an unofficial extension whose output shape keeps changing; a parser would rot. Label pi scope "main session only". Make ass-rc52 Claude-only. Rationale: cost of maintaining a moving target vs. one harness's rare feature.
B. Claude numbers: read subagents/agent-*.jsonl for USAGE ONLY (parse usage, model, timestamps; discard content), dedupe by message.id with main preferring the non-sidechain copy (ccusage rule), and report as a separate "subagents" line next to "main": totals, per-model cost, count. Never in the context chart or cache-miss detection. Rationale: item 1 shows this is exact vs cost-state; 2/3 show the tool_result cannot be used; 5 says shipping transcripts is expensive.
C. Attribution: link each subagent file to its launching step via meta.json toolUseId (present) so the rail can show per-turn subagent spend on the launching turn; async completions still attribute to the launching turn, not the notification turn.
D. Upload: do not publish subagent transcripts in v1. Publish only numeric per-subagent summaries (agentType, description length-capped or omitted in brief/minimal modes, model, usage, tool count). Rationale: privacy/redaction surface identical to main transcript, ~113 KB/agent, and share modes already project the main transcript. A later ticket can add expandable subagent transcripts if wanted.
E. resolve.ts/--current: subagent files live at <projects>/<slug>/<session-id>/subagents/; the adapter needs to be handed the session dir, not just the .jsonl. Small change; add the fixtures below.
F. Fixtures: copy a sanitized trimmed version of the sandbox sessions (background x2 + foreground + mixed-model) into src/fixtures; they contain no real data. Add a test asserting main+subagent totals == embedded cost-state numbers.
G. Independent quick fix (could ship before the rest): stop presenting tool_result totalTokens/usage as subagent totals for Claude (item 2).

PROPOSED TICKETS: (1) fix/relabel subagent chip [G]; (2) adapter: read subagent files for usage, dedupe, schema SessionStats.subagents + per-step link [B,C,E]; (3) viewer: separate "subagents" line in rail/header, per-turn attribution [B,C]; (4) fixtures + cost-state cross-check test [F]; (5) optional: expandable subagent transcripts (deferred, [D]).
OPEN QUESTIONS: does /btw or a forked skill write sidechain lines that replay parent messages (ticket mentions ccusage guard) - untested; resumed subagents (SendMessage) are untested - if they append to the same file, per-agent totals must still dedupe by message.id; agent-heavy real sessions from other machines would still be valuable to confirm.

**2026-09-30T14:55:37Z**

DECISIONS (2026-09-30, with the user) and breakdown.
1. Upload: Option B, numbers PLUS a bounded summary. Subagent transcripts are not published (deferred as ass-z5og). Rationale: numbers alone close the accounting gap exactly (files == cost-state); a bounded summary answers "what did it do" cheaply; full transcripts cost ~113 KB/agent, need redaction/projection per file and depend on a layout that changes between Claude Code versions.
2. Privacy: Option 1, follow existing step rules. Per-agent text (description, agents, bounded result) lives only on the SubagentStep and is projected by the current modes (full keeps truncated, brief/minimal drop result, prompts drops all but numeric aggregates). SessionStats.subagents is numbers-only and computed on the full pre-projection session. Rationale: no new exposure, no second copy of text for projection to forget.
3. Claude only. pi keeps its best-effort chip, scope labeled "main session only".

NEW FINDING while writing the breakdown: the adapter turns background-subagent <task-notification> user messages into user turns, and prompts mode then publishes the subagent's result text as a "prompt" (verified on a synthetic session). This is a privacy bug in an existing mode; it is ass-xz9u, priority 1, and should go first. It also means real Claude sessions with background subagents (the 2.1.285 default) already render oddly.

TICKETS (order): ass-xz9u (p1 bug: notifications as turns, prompts-mode leak) -> ass-cjrn (p2 bug: relabel last-call chip; independent) ; ass-zc54 (p2: sanitized fixtures + cost-state invariant) -> ass-75mx (p2: read subagent files, dedupe, SessionStats.subagents, bounded summary; depends on xz9u and zc54; also covers /btw, forked skill, resume, nested cases) -> ass-5r99 (p3: viewer line, per-turn attribution) ; ass-z5og (p4 deferred: expandable transcripts). Fast-mode pricing for subagent calls comes from ass-zr02 part 3 (linked from ass-75mx).
Investigation deliverable complete; closing this ticket. Reopen if new findings (e.g. real agent-heavy sessions) contradict the design.
