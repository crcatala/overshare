---
id: ass-zr02
status: open
deps: []
links: [ass-lq0c, ass-jx4l, ass-75mx, ass-cjrn]
created: 2026-09-30T02:57:41Z
type: task
priority: 3
assignee: cc-vps
tags: [tokens, cost, adapters, pricing]
---
# Usage hardening: fork detection, price drift, unmodelled price tiers

## Context

Follow-ups from the review of PR #15 (ass-jx4l, token rail accuracy), deliberately deferred. None blocks that PR; each is a hardening or tooling task with its own investigation.

## 1. Fork detection depends on timestamps

pi marks a response `inherited` when its entry timestamp is earlier than the fork header's (`inheritedTest` in `src/adapters/pi.ts`). It matched ccusage's usage-signature dedupe on all 7 local forks (and another reviewer's six on a different corpus), but:
- an entry with a missing or unparseable timestamp counts as the fork's own spend (pinned by a test in `tests/usage-accuracy.vitest.ts`, not endorsed);
- an unparseable header timestamp disables inheritance for the whole file.
Options: treat a missing entry timestamp as inherited when its neighbours are; or match usage signatures against the parent session file like ccusage (`rust/adapters/pi/src/parser.rs`, prefix match bounded by the fork timestamp) when the parent is available. Decide, then change the test that pins the current behaviour.

## 2. Vendored prices drift silently

`src/pricing-data.ts` is generated from pi's catalog by `scripts/update-prices.mjs` and nothing tells us when it goes stale; `LEGACY_PRICES` in `src/pricing.ts` is hand-kept.
- Add an expected-price test for the models we most rely on, and a scheduled job or CI hint that runs `npm run update:prices` and reports a diff.
- Verify catalog oddities against Anthropic's published list prices before trusting them: `claude-opus-5` is $5/$25 while `claude-opus-5-5` is $4/$20 (the latter is confirmed by regression against Claude Code's own `cost-state`, the former is not); `claude-fable-5` has cacheRead $1 vs `claude-fable-5-1` $0.25.
- Consider a second source (models.dev / LiteLLM snapshot, as ccusage uses) as a cross-check.

## 3. Price components the estimate does not model

The estimate can undercount (the cost tooltip says so). Modelling needs transcript signals we do not have today, so start by finding out which exist:
- long-context premium for prompts above 200k tokens (ccusage models it via `input_above_200k` tiers; pi's Anthropic catalog has no tiers, and Opus 5.5 with `[1m]` fit a single rate exactly in the local data);
- fast-mode premium (`usage.speed`; ccusage `fast-multiplier-overrides.json`); all local transcripts report `speed: standard`;
- regional / data-residency 1.1x (Claude Code v2.1.239+ multiplies it into its own figure; `usage.inference_geo` is `not_available` locally).
Acceptance: a written finding per component (signal available? affects which sessions?) and, where a signal exists, a modelled price with a test and the tooltip line narrowed accordingly.

## Related
- ass-jx4l (the PR these came from), ass-lq0c (terminology; the "responses" label now also counts compaction/keep-alive calls).


## Notes

**2026-09-30T14:38:38Z**

Part 3 findings (2026-09-30), measured on Claude Code 2.1.285 with two Opus 5.5 sessions in a sandbox repo (same prompt: main + 1 foreground subagent; transcripts in ~/.claude/projects/-home-mog-workspace-usage-sandbox/ sessions 2a10ef7b = fast, edf2048e = standard). Fast mode cost real usage credits (~$0.61 + $0.23), so this was deliberately small.

FAST MODE: a signal exists. Every call in a fast session has usage.speed == "fast" (standard otherwise), in main AND subagent files (subagents inherit fast). cost-state has no speed field, but its totalCostUSD includes the premium: with our estimateCost, the standard session matches cost-state exactly (ratio 1.000) and the fast session is exactly 2.000x (all four token classes, including cache read/write). Matches the docs' $8/$40 vs $4/$20 for Opus 5.5. Recommendation: model it as a per-call multiplier keyed on (usage.speed == 'fast', model) with the multiplier derived from a small table (Opus 5.5: 2.0; Opus 5 / 4.8 docs say $10/$50, i.e. 2.0x vs $5/$25 standard, but only Opus 5.5 verified locally). Add the test using these two sessions as fixtures, and narrow the cost tooltip to drop the fast-mode caveat. The adapter must carry usage.speed into Usage (currently dropped). Expect fast sessions to be rare (needs Opus + usage credits), so low urgency but the fix is small and verified.
Caveat: the docs say the first enable mid-conversation is billed at full uncached input for the whole context; not tested (would need a mid-session toggle) - likely shows as one large cache write/input call and should already be priced right at 2x.

REGIONAL 1.1x: no signal. inference_geo is 'not_available' in all 11.8k local usage records plus all new sandbox runs. Cannot model; leave the tooltip caveat and revisit if a transcript ever shows a geo value.

LONG-CONTEXT >200k: no evidence locally beyond the earlier note (Opus 5.5 with [1m] fit a single rate). No cheap way to generate a >200k session on demand; leave as-is, keep the caveat.

Also relevant to price checks: opus-5-5 entry ($4/$20, cacheRead 0.2, write 5) reproduced cost-state exactly on standard speed with 1h and 5m writes, so it is confirmed for both write TTLs.
