---
id: ove-xxsk
status: open
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

