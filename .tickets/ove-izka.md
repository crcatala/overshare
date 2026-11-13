---
id: ove-izka
status: open
deps: []
links: [ass-zr02]
created: 2026-11-13T15:33:10Z
type: epic
priority: 2
assignee: cc-vps
tags: [pricing, cost, tokens, automation]
---
# Price table: models.dev source, tiered prices, automated refresh

Keep the Claude price table behind the viewer's *est. cost* current without anyone remembering to do it, and price the models it misses today.

## Problem

Claude Code transcripts record tokens, not cost, so overshare estimates Claude cost from `src/pricing-data.ts` (generated) plus `SUPPLEMENTAL_PRICES` in `src/pricing.ts` (hand-kept legacy models). pi records its own per-call cost, so non-Anthropic models need no table. As of 2026-11-13:

- **The table is stale.** Last regenerated 2026-09-29. Missing `claude-haiku-5-5` (131 local Claude sessions) and `claude-fable-5-2` (4 local sessions): those calls are unpriced and the totals show as partial (`$X+`). `claude-sonnet-5-5` cacheRead is $0.20 in the table; every source now says $0.10.
- **The refresh is blocked.** `npm run update:prices` throws on Haiku 5.5, the first Claude model with tiered (long-context) prices, because `estimateCost` has no tier support.
- **The source depends on the machine.** The script reads pi's bundled catalog via `which pi`. On the dev machine that resolves to a July install (pi 0.80.6; npm latest is 1.5.2), whose catalog lacks Fable 5.2. Nothing warns about it.
- **Nothing tells us the table is stale.** No scheduled check, no CI check (ass-zr02 part 2).

## Approach

1. Teach the estimator about price tiers (ove-xxsk).
2. Generate the table from **models.dev** directly, with **LiteLLM** as an automated cross-check, and pin the prices we've verified against Claude Code's own `cost-state` (ove-hfgj).
3. Preflight checks in the local audit so a stale table or unpriced model can't go unnoticed (ove-9j71).
4. A scheduled GitHub Action that keeps exactly one "update prices" PR open, current with the source (ove-0c8w).

## Decisions and rationale (2026-11-13)

- **models.dev as the source of truth.** MIT-licensed, community-maintained, several commits a day; Fable 5.2 appeared the day it shipped (2026-11-09). Its Anthropic entries match pi's catalog field for field (pi appears to be downstream of it), so switching changes no current price; it just removes a stale middle step and the machine dependency. Tiers come structured: `cost.tiers[{input, output, cache_read, cache_write, tier: {type: "context", size: 100000}}]`.
- **LiteLLM (`model_prices_and_context_window.json`) as a cross-check only.** Also current, and it states the 1h cache-write price explicitly (`cache_creation_input_token_cost_above_1hr`), which independently confirms our "1h write = 2x input" rule. Its licence metadata is mixed and its tier encoding is flat keys (`*_above_100k_tokens`), so it's a better checker than primary. Disagreements are reported, not fatal: two community sources can both lag, and a human reviews the PR either way.
- **Vendored snapshot, never a runtime fetch.** Cost is computed in the CLI at share time and stored in the share. A live fetch would add a network call to a privacy-focused tool, make output depend on a third-party site being up, and make tests non-reproducible. The scheduled PR gives nearly the same freshness.
- **Still hand-kept:** `SUPPLEMENTAL_PRICES` (neither source lists Claude 3.x, Sonnet 4, Opus 4 / 4.1) and any fast-mode multiplier (neither source has one; tracked in ass-zr02 part 3).
- **No auto-upgrading of pi or Claude Code from repo scripts.** It would change global tools outside the repo and fight mise pins. Once the source is models.dev, the price script no longer depends on pi at all.

## Out of scope

Fork detection and fast-mode / regional pricing (ass-zr02 parts 1 and 3). Prices for non-Anthropic models (pi records cost itself).

Supersedes ass-zr02 part 2 (price drift).

