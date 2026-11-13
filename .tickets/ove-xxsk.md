---
id: ove-xxsk
status: closed
deps: []
links: []
created: 2026-11-13T15:33:47Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-izka
tags: [pricing, cost]
---
# Support tiered (long-context) prices in the cost estimate

## Problem

Haiku 5.5 is the first Claude model with tiered prices: $0.10 / $0.50 / $0.01 / $0.125 (in / out / cache read / 5m write) up to 100k context, $0.50 / $2.50 / $0.05 / $0.625 above. `ModelPrice` is flat and `estimateCost` applies one rate, so `scripts/update-prices.mjs` refuses to regenerate (it throws on any `tiers`). 131 local Claude sessions use Haiku 5.5 and are currently unpriced.

## Approach

- `ModelPrice` gains optional `tiers: { above: number; input; output; cacheRead; cacheWrite }[]`, sorted ascending by `above`.
- `estimateCost` picks the tier from the call's prompt size, `input + cacheRead + cacheWrite` (the same quantity as "peak context"), and the 1h cache-write rate is 2x that tier's input.
- **Settle before coding:** does the higher rate cover the whole call (Anthropic's long-context pricing has historically worked this way, and models.dev's `type: "context"` reads that way) or only the tokens above the threshold? Check against Claude Code's `cost-state` on local Haiku 5.5 sessions with calls on both sides of 100k, using `npm run audit:usage`. Record the finding in this ticket.
- `src/cache.ts` (cache-miss extra cost) also reads prices: make it tier-aware, or document why the base tier is good enough there.
- The `update-prices.mjs` throw goes away; the generator writes tiers.
- Update the cost tooltip and `docs/viewer.md` if what's "not modelled" changes.

## Acceptance criteria

- Unit tests: a call just under and just over the threshold; 5m and 1h writes in the upper tier; a model without tiers is unchanged.
- The tier semantics finding is written down with the local evidence (session ids truncated to 8 chars, no transcript text).
- Haiku 5.5 sessions get a cost; `audit:usage` shows them within the usual band versus `cost-state` (a little below, never above).
- No change to any existing non-tiered price or test.


## Notes

**2026-11-13T16:24:41Z**

Tier semantics settled (2026-11-13): the upper tier prices the WHOLE call, not only the tokens above the threshold.

Evidence, from the local Claude Code sessions that mention claude-haiku-5-5 (142 files, 122 with a Haiku 5.5 entry in cost-state.modelUsage). For each session: Haiku 5.5 calls summed over unique message ids in the main file and its subagent files, priced per call under each hypothesis; the tokens cost-state holds beyond the transcript (background calls the transcript never shows) priced at the base rate, plus cost-state's webSearchRequests at $0.01 each (Claude Code bills web search to the Haiku entry). Compared with cost-state's modelUsage["claude-haiku-5-5"].costUSD:

- Whole call at the tier rate when prompt (input + cacheRead + cacheWrite) > 100k: 121/122 sessions exact (|err| < 1e-6).
- The two sessions with calls on both sides of 100k: 131d09a3 (10 calls, 3 over, largest prompt 565k) and a280d8cc (12 calls, 1 over, prompt 114,230): whole-call 0.0000% on both; "only tokens above 100k at the higher rate" -10.2% and -26.6%; base rate only -67.4% and -34.3%.
- The one session that does not match, dc2e51f4, is exactly -80.000% under every hypothesis: its only Haiku 5.5 usage is a background call the transcript lacks with a 398k prompt, i.e. billed whole at the upper tier (5x base), which also fits whole-call.
- No local call has a prompt of exactly 100,000, so ">" vs ">=" is not observable; we use ">" (models.dev: tier size 100000; "above 100k").
- No local upper-tier call has 1h cache writes, so the 1h rate in the upper tier is not checked against cost-state. LiteLLM states it explicitly: cache_creation_input_token_cost_above_1hr_above_100k_tokens = $1.00/M = 2 x the tier's $0.50 input, matching the 2x-input rule.

Side finding (not in scope): Claude Code adds web search requests ($0.01 each) to cost-state; transcripts don't price them, one more reason the estimate sits below cost-state.
