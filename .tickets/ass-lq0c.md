---
id: ass-lq0c
status: open
deps: [ass-jx4l]
links: [ass-jx4l, ass-rc52]
created: 2026-09-30T02:18:33Z
type: feature
priority: 2
assignee: cc-vps
tags: [viewer, tokens, cache]
---
# Token rail: surface cache misses by turn + terminology pass (PR 2 of 2)

## Context

Depends on PR 1 (accuracy ticket): needs `cacheWrite1h`, per-response Claude cost and the price table for the extra-cost estimate. From the 2026-09-29 token audit: the rail says "cached 99%" while a single cache miss can cost real money and the user has no way to see where in a session it happened.

Evidence (dev-machine Claude sessions, 1h cache TTL on subscriptions, 5m on API keys per Claude Code docs "Manage costs effectively"): across all Claude calls, gaps up to 60 min stayed 97-100% cached; gaps of 60-120 min averaged 36% cached; gaps over 2h averaged 21%. In session 68bb822e a 271-min idle resume produced one call with 413k context, 6% cached, 388k tokens re-written: ~$3.1 versus ~$0.08 had it been cached; the rail still showed 99% cached. Session 791bc054 had a 476-min idle plus a compaction; session 4c6e00c2 had a 768k-context call with 3% cached after only 5 minutes (a non-idle break, cause unknown). Wall-clock gap alone is not a perfect predictor (a87325d3 stayed 100% cached across a 100-min gap, likely hidden keep-alive calls), so detect misses from the token numbers and use the gap only as explanation. Old sonnet-4-5 sessions (5m TTL) show 0% cached after a 26-min gap.

Claude Code itself defines this: `/usage` shows "Prompt cache (main): N requests · X% of input tokens from cache · M misses (last 6m ago, 310k tokens re-cached) · 1 expected rebuild (compaction or tool-result clearing) · warm (1h TTL)". A miss is a request that re-processed more than 5% and at least 2,000 tokens of what it could have read from cache; compaction and tool-result clearing are "expected rebuilds". Reuse that vocabulary.

## Scope

### A. Detection (adapter or shared pure function, browser-safe, unit-tested)
For consecutive model calls on the exported branch (same model), expected cacheable prefix = previous call's context (input + cacheRead + cacheWrite). Miss when `prevContext - cacheRead > 5% of prevContext` and `>= 2,000` tokens. Record per miss: response id, turn, tokens re-processed (`prevContext - cacheRead`, capped at this call's context), idle gap since previous call (when timestamps exist), extra cost, and a `kind`:
- `miss`: unexplained or idle-gap miss (label "after 4h 31m idle" when gap exceeds the cache TTL for the session, else just "cache miss").
- `rebuild`: first call after a compaction event, expected (label "after compaction").
- `model-switch`: first call after the model changes (cache is per model), expected.
Not a miss: the first call of a session, the first call after a hole in usage data, calls with no cache fields at all (provider reports no caching; show nothing rather than "0% cached").
Extra cost = re-processed tokens x (write price - read price) for Claude (1h vs 5m write per `cacheWrite1h`); for pi/OpenAI-family where cacheWrite is 0, use (input rate - cacheRead rate) taken from that response's recorded cost breakdown if the adapter can keep it (open design point: add optional cost breakdown/rates to the response, or omit $ for pi). Omit the $ figure whenever the rate is unknown.
Provider-specific caveat to validate: OpenAI-style caching reports `cacheRead` in coarse increments and is best-effort; check the false-positive rate on the pi sessions (15k responses, e.g. 01a07be6 across its 52-min gap stayed cached) before shipping thresholds.
Store as `SessionStats.cache` (summary: requests, cachedPct, misses, rebuilds, extraCost) plus per-response flags (e.g. `ResponseUsage.cacheEvent`), additive and optional so old shares render without the section. Computed on the full pre-projection session so share modes do not change it.

### B. UI
- Context-by-turn chart: mark columns that contain a miss/rebuild/model-switch (distinct, accessible marker, not color-only; legend entry). Bucketed columns must keep the marker if any member has one.
- New rail section "Cache" (between Session and Context by turn, or after; pick and justify): summary line in Claude Code's wording ("N misses · M expected rebuilds · ~$X extra") and a list, one row per event: turn number, kind, idle gap, tokens re-cached, extra cost. Rows are buttons that jump to the turn/step (same mechanism as tool-call lists). Cap the visible rows with "+N more" like the tools list.
- In-view Turn box: a line when that turn contains an event ("cache miss after 4h 31m idle: 388k re-cached, ~$3.10").
- Header facts: "cache misses: N (~$X)" only when N > 0.
- Turn foot in the transcript: append "cache miss" when applicable.
- Tooltip/help text explains what a miss is, why idle time causes it (TTL 1h on subscription, 5m on API keys; do not hard-code which the user has: say "typically 5 min to 1 h depending on plan"), and that compaction/model switches are expected.
- Replace the session-wide "cached %" wording so it cannot be read as "no problems": label it "cache hit (tokens)" or similar and show it next to the miss count.

### C. Terminology pass (do together, small)
Standardize on "model call" (drop "response" in rail, turn foot, header, CLI report; internal names may stay). Rename the header "tokens" figure to "tokens processed" with a tooltip that it counts context re-read from cache on every call, or replace it with explicit rows (new input, output, cache read, cache write). "new input" -> "uncached input" if that reads clearer in the legend; "peak ctx" -> "peak context"; expand "think" -> "thinking" everywhere. Keep the est. cost label from PR 1. Update the README section on the rail if it describes these.

## Acceptance criteria

- On session 68bb822e the 271-min resume is flagged as a miss with its idle gap, ~388k re-cached and an extra-cost figure near $3; the chart column is marked; clicking its row in the Cache section jumps to that turn.
- 791bc054: the 476-min idle miss and the compaction rebuild are both flagged and distinguished (miss vs expected rebuild).
- pi 01a07be6 (compaction at 262k -> 23k): the first post-compaction call is a rebuild, not a miss; ordinary calls in that session are not flagged.
- A model switch (pi `2026-09-14T12-39-21...` glm <-> gpt-5.6-luna) is labeled model-switch, not miss.
- False-positive check on the local corpus documented in the PR: number of flagged calls per harness and a spot check of the top 10 by cost; thresholds adjusted if OpenAI-style coarse cache reads produce noise.
- Calls with no cache reporting show no cache UI. Old shares without the new fields render as before.
- Unit tests cover: detection thresholds (5% / 2,000), same-model requirement, compaction rebuild, model switch, idle gap explanation with and without timestamps, bucketing keeps markers, extra-cost math for 5m vs 1h writes, no-cache-fields provider.
- Terminology is consistent across rail, header, turn foot, tooltips and CLI report (grep "response" in user-visible strings).
- `npm test`, `npm run typecheck`, `npm run build` pass; browser-verify light/dark, desktop and 390px, Claude and pi fixtures (extend fixtures to include an idle-gap miss and a compaction), screenshots attached to the PR.

## Out of scope

Predicting misses or advising the user; cross-session cache analysis; subagent cache behavior (Claude Code's own "Prompt cache (main)" line also excludes subagents).

