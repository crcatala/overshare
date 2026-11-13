---
id: ove-hfgj
status: open
deps: [ove-xxsk]
links: []
created: 2026-11-13T15:33:47Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-izka
tags: [pricing, cost, scripts]
---
# Generate the price table from models.dev, cross-checked with LiteLLM

## Problem

`scripts/update-prices.mjs` reads pi's bundled catalog through `which pi`, so the result depends on whichever pi install is on the machine (currently a July build missing Fable 5.2). Nothing checks the numbers against a second source, and nothing pins the prices we've verified.

## Approach

- **Source:** fetch `https://models.dev/api.json` and read `anthropic.models`. Keep `claude-*` ids with a `cost`; map `cache_read`/`cache_write` to `cacheRead`/`cacheWrite`, and `tiers[].tier.size` to `above` (`type` must be `context`; any other tier type fails loudly). Keep a `--from <file>` option so tests and offline runs can use a saved copy.
- **Cross-check:** fetch LiteLLM's `model_prices_and_context_window.json` (`BerriAI/litellm`, main), filter on `litellm_provider == "anthropic"`, convert per-token to per-million, and compare base rates, tier rates (`*_above_100k_tokens`) and the 1h write (`cache_creation_input_token_cost_above_1hr` should equal 2x input). Print a disagreement report; never fail on it. Models only in one source are listed too.
- **Output:** `src/pricing-data.ts`, same shape, header naming models.dev and the date of the snapshot. Deterministic (sorted, stable number formatting) so an unchanged source produces no diff.
- **Modes:** `--check` exits non-zero if the regenerated table differs from the committed one (for the bot and for local use); `--json` writes a machine-readable summary (added/changed/removed models, cross-check disagreements) for the bot's PR body.
- **Pinned prices test:** pin only the prices confirmed against Claude Code's `cost-state` (opus-5-5 at both write TTLs, haiku-4-5, plus the Haiku 5.5 tiers once the tiers ticket confirms them). This guards against a source typo, not against drift. Keep the existing `findPrice` id-normalisation tests.
- `SUPPLEMENTAL_PRICES` stays hand-kept; the generator must never emit an id that shadows one unless the values match.
- Update `docs/development.md` and `docs/viewer.md` (source, flags, and that pi is no longer needed).

## Acceptance criteria

- `npm run update:prices` works on a machine with no pi installed.
- Regenerating today adds `claude-haiku-5-5` (with tiers) and `claude-fable-5-2`, and changes `claude-sonnet-5-5` cacheRead to 0.1; the PR lists every changed entry.
- Re-running with an unchanged source produces no diff; `--check` passes.
- The cross-check report runs on today's data and shows no disagreements (verified manually 2026-11-13: none).
- A fixture-based test for the converter covers a plain model, a tiered model, and an unknown tier type (throws).

