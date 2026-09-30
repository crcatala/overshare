---
id: ass-rc52
status: open
deps: []
links: [ass-lq0c, ass-jx4l]
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

