---
id: ass-jx4l
status: closed
deps: []
links: [ass-lq0c, ass-rc52]
created: 2026-09-30T02:18:30Z
type: bug
priority: 2
assignee: cc-vps
tags: [viewer, tokens, cost, adapters]
---
# Token rail accuracy: est. Claude cost, scope labeling, adapter fixes (PR 1 of 2)

## Context

A 2026-09-29 audit of the token rail compared our numbers with the raw JSONL of 79 Claude Code and 369 pi sessions on the dev machine, Claude Code's own `cost-state` records, pi's source (`@earendil-works/pi-ai`, `pi-coding-agent`), and ccusage (Rust rewrite, `rust/adapters/{claude,pi}`, `rust/crates/ccusage-core/src/cost.rs`). Per-response token math is exact on both harnesses. The problems are in cost, scope and a few adapter edge cases. This ticket is PR 1 of 2: accuracy. PR 2 (cache-miss surfacing + terminology) depends on it.

## Verified facts (do not re-derive; re-verify only if surprised)

- Claude: one API message is repeated across several lines with the same `message.id`; last-wins is correct for current versions. Older versions (sonnet-4-5 era, CC 2.0.x) stream snapshots whose first line has `output_tokens: 1`; ccusage keeps the line with the largest token total, which is safer.
- Claude `thinking_tokens` (`output_tokens_details`) and pi `reasoning` are subsets of `output`. Cost regression against `cost-state` used `outputTokens` only and fit exactly, so reasoning must never be added on top.
- Claude `cost-state` (transcript entry `type: "cost-state"`, `modelUsage` per model incl. `costUSD`) is per PROCESS: `startTime` is the last launch. A resumed session covers only the last segment. Session 68bb822e (271 min idle, resumed): header cost $16.96 next to 95M tokens; price-table estimate for the whole session is $32.22 (-47%). Multiple `cost-state` lines inside one process are cumulative snapshots, so last-wins within a process is right.
- 11 of 72 Claude sessions have no `cost-state`, so the header shows no cost at all. Claude responses never carry per-response cost, so Claude turns get no per-turn cost while pi turns do.
- `cost-state` also covers calls that never appear as assistant messages in the transcript: the compaction request (session 791bc054: ~277k uncached input tokens, ~$1.1), Haiku background calls, subagents. Token totals exclude them, so tokens and cost currently describe different populations.
- Price fits from `cost-state`: claude-opus-5-5 = $4 in / $20 out / $0.20 cache-read / cache-write $5 (5m) or $8 (1h = 2x input). claude-haiku-4-5 = 1/5/0.1/1.25 exact. All local Claude sessions used 1h cache writes (`usage.cache_creation.ephemeral_1h_input_tokens`); API-key users get 5m. pi's catalog (`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json`) matches. Claude Code docs: the figure is a local list-price estimate, not a bill, and is irrelevant for Pro/Max billing. There is also a 1.1x data-residency multiplier on some responses (v2.1.239+) and a fast-mode multiplier (ccusage `fast-multiplier-overrides.json`); neither appears in local transcripts, so handle only if cheap.
- Estimator check (price table x per-response tokens, 60 non-resumed sessions): median -2.7% vs `cost-state`, never above it. The gap is the unlogged calls above. Worst case -32%.
- pi: adapter matches raw per-branch sums exactly; our sum equals provider `totalTokens` on all 15,175 responses. pi recorded `cost.total` is authoritative (pi computes it per call with tiers and 1h cache writes).
- pi scope: 25 of 369 sessions have real spend on abandoned branches that branch-only export omits (up to +27% cost). 7 sessions are forks (`parentSession` in the header) whose files copy the parent's history, so we double count inherited spend (a0cb594c7a75: ours $1.26 vs ccusage $0.31; 4c175e3b4b8a: $0.69 vs $0.47).
- pi extras we ignore but pi's own `getSessionStats` counts: `compaction`/`branch_summary` entries with `usage` (local example 01a07be6: 69,232 in / 1,139 out / $0.0152), `toolResult` messages with `usage`, and standalone `usage` entries (none seen locally yet).
- 154 of 15,175 pi responses (stopReason aborted/error) have all-zero usage; they inflate "responses" and render as empty chart columns.
- `formatTokens` has no B tier ("1045M").

## Scope of this ticket (four groups; land as separate commits)

### A. Schema + price table
- Additive optional fields only. Already-published `agentshare/1` shares must still render (viewer degrades). Add `cacheWrite1h?: number` to `Usage` (portion of `cacheWrite` billed at the 1h rate), and add `"estimated"` to `SessionStats.costSource`.
- Vendor a generated price snapshot for Anthropic models (source: pi-ai catalog; see ccusage's models.dev/LiteLLM snapshot as an alternative). Include a refresh script and a test that fails when a model seen in the fixtures is missing. Model lookup must handle suffixes like `[1m]` and dated ids.
- Unknown model: no cost for that response, never $0. If a session has any unpriced responses, `stats.cost` is a lower bound and the schema/UI says so (e.g. `costPartial`, shown as "$12.40+").
- Claude adapter maps `cache_creation.ephemeral_1h_input_tokens` into `cacheWrite1h`; when the breakdown is absent, treat all writes as 5m.

### B. Claude cost estimated per response
- Compute `usage.cost` per response = tokens x price (in/out/cache-read/5m write/1h write at 2x input); `costSource: "estimated"`. Add >200k long-context tier and fast-mode multiplier only if the price data supports it and it is a small change; otherwise note as known gaps.
- Stop using `cost-state.totalCostUSD` as the session total. Keep it out of the UI. Optional: a local `scripts/audit-usage.ts` (not run in CI, needs local sessions) that compares estimate vs `cost-state`, and pi totals vs `totalTokens`, so price drift is caught.
- pi keeps recorded per-response cost (`costSource: "per-response"`).
- Claude turns now show per-turn cost and running "so far" cost like pi turns.
- Rename cost labels in header, rail, turn foot and CLI report to "est. cost" with a tooltip: "Estimated at API list price from the tokens in this transcript. Not a bill; subscription plans are not charged per token." Keep wording short.

### C. Adapter accuracy
- Claude: when a message id repeats, keep the line with the largest token total (not just the last).
- Exclude zero-usage aborted/error responses from `responses` counts and charts (keep the transcript event). Keep them if they carry any usage.
- pi: count `compaction`/`branch_summary` `usage` and `toolResult` `usage` and standalone `usage` entries in session totals and cost. Attach compaction usage to the compaction event's turn but do not invent a chart column for it (or show it as its own marked column; decide and document).
- pi: when usage parts are missing but `totalTokens` exists, attribute the remainder (ccusage `apply_total_token_fallback`: to output if output is 0, otherwise keep an unattributed extra).
- `formatTokens`: add a B tier.

### D. Scope labeling (branches + forks)
- Adapters (both harnesses) compute usage that exists in the file but is not on the exported branch: `stats.otherBranches = { responses, tokens, cost? }`. Rail/header shows "+N tokens / $X on other branches (not shown)" only when non-zero, with a tooltip explaining the branch-only view.
- pi forks: mark responses inherited from the parent as `inherited: true` (candidate rule: entry timestamp earlier than the session header timestamp; VERIFY against the 7 local fork sessions before relying on it, ccusage instead matches usage-signature prefixes against the parent). Session `stats.tokens`/`cost` cover new work only; `stats.inherited = { responses, tokens, cost? }` is shown separately ("+ inherited from parent: ..."). Inherited turns still appear in charts but visually muted. Claude Code has no equivalent today; leave a code comment.
- All stats keep being computed on the full pre-projection session so share modes do not change numbers (existing behavior; add a test).
- Until the subagent ticket lands, the rail/tooltip states that figures cover the main conversation only.

## Acceptance criteria

- On session 68bb822e the header cost is within ~5% of the price-table estimate for the WHOLE session (~$32), not $16.96; all Claude sessions with any priced model show a cost, including the 11 that lacked `cost-state`.
- Claude turns show per-turn and running cost. pi numbers are unchanged except where D/C intentionally change them (forks, compaction usage, zero-usage responses).
- pi fork 4c175e3b4b8a and a0cb594c7a75: session totals exclude inherited history; inherited totals are shown separately and sum with new work to the previous totals.
- pi session with abandoned branches (e.g. 1cac2d6a8984): other-branch tokens/cost appear and match a raw all-branch sum.
- pi compaction session 01a07be6: compaction call usage is included in totals and cost.
- Zero-usage aborted pi responses no longer count as responses (154 locally).
- Unknown-model Claude session: no $0; partial-cost marker shown.
- Old published shares (fixtures without new fields) render exactly as before, minus nothing crashing. Add fixtures/tests for: 1h vs 5m writes, repeated message id with growing output, resumed Claude session (cost-state present but ignored), fork, other-branch spend, compaction usage, unknown model.
- `npm test`, `npm run typecheck`, `npm run build` pass. Browser-verify the rail in light/dark on a Claude and a pi fixture and attach screenshots to the PR.
- No behavior change to redaction or share modes.

## Out of scope

Cache-miss detection and its UI, and the remaining terminology changes (PR 2, see its ticket). Claude subagent usage (separate ticket).


## Notes

**2026-09-30T02:38:16Z**

Implemented on feat/token-accuracy. Schema additions are optional-only (cacheWrite1h, ResponseUsage.purpose/inherited, stats.costPartial/otherBranches/inherited, costSource 'estimated'), so published shares render unchanged. Claude cost is estimated per response from a vendored price snapshot (scripts/update-prices.mjs, source: pi-ai catalog); cost-state is no longer read. Verified on the dev corpus with 'npm run audit:usage': estimate vs cost-state median -3.1%, never above; pi token sums equal provider totalTokens on 15,175 calls. Local results: 68bb822e now $32.22 (was $16.96); the 7 forks match ccusage's new-work cost exactly; 72 zero-usage aborted/error pi calls on exported branches are no longer counted (154 file-wide, the rest sit on other branches). Not done here by design: subagent usage (ass-rc52), cache-miss UI + terminology (ass-lq0c).
