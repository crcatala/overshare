---
id: ove-f6hn
status: open
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
src/cache.ts decides a model caches explicitly (Anthropic style, 5-minute TTL logic) when `findPrice(model) !== undefined`. Adding OpenAI or Gemini prices to the same lookup would wrongly mark them explicit and produce false cache misses. The price table needs to know each model's provider, and cache.ts should ask "is this an Anthropic model", not "do we have a price".

## Scope
- Generate OpenAI (`openai.models`) and Google (`google.models`) prices from models.dev, cross-checked against LiteLLM, in the same generated file or a sibling, with the provider recorded.
- Model id normalization: Codex ids as written (`gpt-6.1-sol`, `gpt-5.1-codex`); Antigravity's `model` field carries the thinking level (`gemini-4-neon-high`), price the base model (`gemini-4-neon`).
- OpenAI caching: cached input is billed at the cache-read rate, no write premium. Gemini: same unless the model is a Claude one served by Antigravity.
- The price-update workflow (update-prices.yml) and its bot test keep working.

## Acceptance
- [ ] findPrice resolves current GPT and Gemini ids; tests pin a few rates.
- [ ] cache.ts classifies by provider; existing cache tests unchanged; a new test shows a GPT session with only cached reads reports no explicit-cache misses.
- [ ] Claude Code and pi share output unchanged (fixtures diff only in sharedAt).

