---
id: ove-f6hn
status: closed
deps: []
links: []
created: 2026-11-20T18:20:21Z
type: task
priority: 2
assignee: cc-vps
parent: ove-v5c6
tags: [pricing, cache, codex, antigravity]
---
# Prices for OpenAI and Gemini models, without breaking cache-miss classification

## Why
Neither Codex nor Antigravity records a cost, so overshare estimates it from tokens. src/pricing-data.ts only has Anthropic models: scripts/prices.ts reads models.dev `anthropic.models` and cross-checks LiteLLM entries with `litellm_provider === "anthropic"`.

## The catch
src/cache.ts decides a model caches explicitly (Anthropic style, 5-minute TTL logic) when `findPrice(model) !== undefined`, and `findPrice` (src/pricing.ts) only matches ids against `/claude-[a-z0-9.-]+/`. Adding OpenAI or Gemini prices to the same lookup would wrongly mark them explicit and produce false cache misses. The price table needs to know each model's provider, and cache.ts should ask "is this an Anthropic model", not "do we have a price".

## Scope
- Generate OpenAI (`openai.models`) and Google (`google.models`) prices from models.dev, cross-checked against LiteLLM, in the same generated file or a sibling, with the provider recorded.
- Model id normalization: Codex ids as written (`gpt-6.1-sol`, `gpt-5.1-codex`); Antigravity's `model` field carries the thinking level (`gemini-4-neon-high`), price the base model (`gemini-4-neon`).
- OpenAI caching: cached input is billed at the cache-read rate, no write premium. Gemini: same unless the model is a Claude one served by Antigravity.
- The price-update workflow (update-prices.yml) and its bot test keep working.
- Side effect on pi: pi records rates per call, but once GPT ids resolve, pi sessions on GPT models without recorded rates could gain `cacheEvent.cost` / `extraCost` values (the pi fixture uses `gpt-6-luna`). Decide whether that is wanted; if so, say so in the changelog and accept the fixture diff.

## Acceptance
- [ ] findPrice resolves current GPT and Gemini ids; tests pin a few rates.
- [ ] cache.ts classifies by provider; existing cache tests unchanged; a new test shows a GPT session with only cached reads reports no explicit-cache misses.
- [ ] Claude Code share output unchanged (fixtures diff only in sharedAt); pi output unchanged too, or changed only where the decision above says so.


## Notes

**2026-11-20T18:58:14Z**

Decisions (PR for ove-f6hn): (1) pi side effect accepted: a pi miss on a GPT/Gemini model is priced from the table only when pi's recorded costs don't give that model's rates; 0 of 522 local pi sessions changed, fixtures unchanged; noted in CHANGELOG. (2) cache.ts asks priceProvider(model) === 'anthropic' instead of findPrice(model) !== undefined. (3) One generated file, three tables (ANTHROPIC_/OPENAI_/GOOGLE_PRICES); the provider follows from the id family (providerOfId), so the flat id space and diff/bot code stay as they were. (4) OpenAI/Google cache rates models.dev omits are read as the input rate (no discount / no write premium), never 0. (5) Codex variants models.dev lacks (gpt-5-codex, gpt-5.1-codex[-mini|-max], gpt-5.2-codex) are hand-kept in SUPPLEMENTAL_PRICES from LiteLLM/OpenAI list prices. (6) Gemini thinking-level suffix stripped in findPrice as a fallback after the exact id.
