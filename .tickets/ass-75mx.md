---
id: ass-75mx
status: open
deps: [ass-xz9u, ass-zc54]
links: [ass-xz9u, ass-z5og, ass-5r99, ass-zc54, ass-rc52, ass-cjrn, ass-zr02]
created: 2026-09-30T14:55:28Z
type: feature
priority: 2
assignee: cc-vps
tags: [claude-code, subagents, tokens, adapters, schema]
---
# Claude subagent usage and bounded summary: read subagent files, dedupe, SessionStats.subagents

Implements the recommended design from the ass-rc52 investigation. Read the ass-rc52 notes first (findings 1-7, recommendations A-G).

## Decisions (made 2026-09-30)
1. Upload = Option B: numbers PLUS a bounded summary. From each subagent file we take usage (tokens, model, per-call cache TTL split), tool count and duration, and a bounded final-result summary. We do NOT publish subagent transcripts (deferred, see the transcripts ticket). Rationale: numbers alone give the missing totals exactly (sum of files == cost-state); the bounded summary gives "what did this agent do" cheaply. The summary text is the same class of content the launching step already carries (`SubagentStep.result`), so existing projection and redaction apply unchanged. Full transcripts would cost about 113 KB per agent and tie us to a file layout that changes between versions.
2. Privacy = follow the existing step rules (option 1). Per-agent text (`description`, `agents`, bounded `result`) lives ONLY on the SubagentStep and is projected by the modes that exist: full keeps it (truncated), brief and minimal drop `result` but keep description/agents/usage, prompts drops everything except numeric aggregates. `SessionStats.subagents` carries numbers, model and counts and NO text, so there is no second copy for projection to forget. Stats are computed on the full pre-projection session (like SessionStats.cache) so share modes do not change them. Rationale: adds no new exposure; reuses reviewed code.
3. Claude only. pi keeps its best-effort chip from `details.totalChildUsage` and its scope is labeled "main session only" (pi-subagents is an unofficial, fast-changing extension).

## Scope
- Loading: `parseClaudeCode(raw, options)` stays pure and browser-safe; add an option carrying the subagent files (`{fileName, raw, meta}[]`). The CLI/pipeline loads `<session-dir>/subagents/agent-*.jsonl` and `.meta.json` next to the session file (session dir = path without `.jsonl`). `listSessions` already skips `agent-*` files; `--current` and resolve need no change beyond passing the directory. Tolerate a missing dir, malformed lines and unknown meta fields (the layout changed across versions; background became the default in 2.1.285).
- Parsing: reuse the main-transcript usage logic; dedupe by `message.id` with the non-sidechain copy preferred (ccusage rule); per-call cache TTL split from `cache_creation.ephemeral_*` (subagents may write 5m while main writes 1h); cost via the shared estimate (includes the fast-mode multiplier once ass-zr02 part 3 lands; do not fork the pricing code).
- Link each subagent to its launching step by `meta.json.toolUseId` (fallback: task-notification `<tool-use-id>`). Async completions attribute to the LAUNCHING turn, not the notification's.
- Schema (additive, optional): `SessionStats.subagents` {agents, calls, totals per token class, cost, byModel}; a bucket for subagent files whose toolUseId matches no step on the exported branch (label like the "other branch" usage from PR 1; never silently folded into main totals); per-step `SubagentStep.usage` becomes the file-derived TOTAL (replacing the last-call figures) and `SubagentStep.result` gets the bounded summary (final assistant text of the subagent when the tool_result has none, i.e. async).
- Summary bound: decide a character cap (suggest 2,000 in full mode, same truncation helper as tool results) and pass the text through the same redaction path as the main transcript before upload.
- NOT in the context-by-turn chart and NOT in cache-miss detection (a subagent's context is its own window; Claude Code's "Prompt cache (main)" excludes subagents).
- Cover the untested cases from the ass-rc52 note by generating them in ~/workspace/usage-sandbox: /btw sidechain replays of parent messages, forked skills (`.forked-skill*.json`), resumed subagents (SendMessage; if they append to the same file, dedupe by message.id), nested subagents (`spawnDepth` > 1). Record findings in the PR; add fixtures for those that behave differently.

## Acceptance
- Cross-check test: for every fixture session, main + subagent totals equal the embedded cost-state numbers.
- Tests for: dedupe (main copy preferred, no double count), 5m/1h split, mixed-model cost, async vs foreground vs parallel, unlinked-subagent bucket, missing/malformed files, prompts-mode output has no subagent text and only aggregate numbers, brief/minimal drop `result`, full keeps the truncated summary, stats identical across all share modes. Confirm new tests fail without the implementation.
- Old shares without the new fields still render (all additive/optional).
- Run against the local corpus: 5faff187 (the one real subagent session) matches its cost-state; report in the PR.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Out of scope
Viewer changes (separate ticket), subagent transcripts, pi subagent support, predicting or advising on subagent spend.

