---
id: ass-iugy
status: open
deps: [ass-5qv5]
links: [ass-13r0, ass-azwt, ass-5qv5, ass-8w1o]
created: 2026-10-02T19:40:50Z
type: feature
priority: 3
assignee: cc-vps
tags: [redaction, security, publish]
---
# redact: confirmation tier for suspicious findings that could not be redacted

Part of the redaction-hardening work from the ass-azwt review. This is the "warn when something suspicious could not be redacted" idea.

## Problem
Redaction has three layers: exact known values, pattern/entropy/key-name heuristics (`src/redact/patterns.ts`, built on `@sanity-labs/secret-scan` = ~1,100 TruffleHog-derived rules plus our own heuristics), and a final rescan over the exact outgoing bytes (`src/redact/rescan.ts`). The rescan only blocks on **high-confidence** matches: `rescan.ts:37` does `if (m.confidence !== "high") continue;`. Medium-confidence matches (`secret-assignment`, generic keyword rules, sensitive-key values) are not re-checked there. So there is no tier for "this looks like it could be a secret, we are not sure we handled it". The user either gets a hard block (high confidence) or nothing.

Related limit (be honest about it in docs and UI copy): this tier only surfaces what a pattern/heuristic layer already matched at medium confidence. A secret with **no recognizable format** matches nothing, so no layer sees it, and this tier does **not** compensate for the recall lost if machine-secret harvesting is narrowed/opt-in (harvesting-config ticket). That gap is exactly why known-value harvesting exists. So there is deliberately no ordering dependency between this ticket and the harvesting-config ticket: the defaults decision there must not rely on this tier.

## Why
A leaked secret in a published share is the worst outcome of this tool (irreversible once indexed). A middle tier gives the user a last chance to look, without crying wolf on every share (confirmation fatigue is the failure mode; keep it for genuinely uncertain items only). The tool must also never print the suspicious values while asking.

## Design notes
- **First verify** (do not assume): which medium-confidence matches does `Redactor` already replace vs leave in place? `redactSession`/`Redactor` mark and replace pattern matches (see `src/redact/index.ts` ~lines 100-145). Build a list of "suspicious and left in the payload" vs "suspicious but replaced" and record it in a ticket note. The new tier is for the first group, i.e. things that remain in the outgoing bytes.
- Add a `suspicious` list to the prepared report next to `rescan` / `findings`: each item has rule, confidence, length, and a **location** but no value characters or hashes (depends on the mask-fragment ticket for the shared shape).
- **Location**: path of the source transcript plus a locator the user can follow to inspect it themselves. Phase 1: message index/role/tool name within the session and the transcript path. Phase 2 (if feasible per harness): source line number for JSONL harnesses. The rescan runs on the projected payload, not the source file, so mapping back needs provenance carried from `parseSession`; scope this honestly and split into a follow-up if it is large.
- **Flow**: high-confidence stays a hard block (unchanged, allowlist to override). Suspicious items require an explicit confirmation naming the count and kinds and telling the user to inspect the transcript at the given path/locations before proceeding. The user can allowlist a finding via the existing allowlist mechanism once reviewed.
- **Non-interactive**: `--yes` must not bypass suspicious items; require the existing `--allow-findings` (or a new explicit flag, decide at implementation) and keep exit code `needsReview` (2) semantics consistent with `src/cli.ts`.
- **Browse**: the publish dialog shows the suspicious items (rule, length, location) and requires an explicit extra confirmation step. "Reviewed payload == uploaded payload" and "nothing sent before explicit y" must hold (existing tests in `tests/browse-flow.vitest.ts`, `tests/browse-source.vitest.ts`).
- Tune to avoid noise: reuse the existing fake/placeholder/hash/UUID filters; the point is a short list. Measure how often it fires on a few real sessions and record it in a ticket note; if it fires on most sessions, tighten before shipping.

## Context
Decision record (2026-10-02): the user wants a warning and confirmation, shown without outputting values, with description/label and where to look, so they can inspect the session manually. Related: mask-fragment ticket (shared no-value report shape), harvesting-config ticket, wrapper ticket.

## Acceptance
- A planted medium-confidence, un-redacted-but-suspicious value produces a `suspicious` entry (rule, length, location) and the publish requires explicit confirmation (CLI interactive prompt; browse extra step). Output and JSON contain no characters of the value.
- `--yes` alone refuses when suspicious items exist, with exit code 2 and a message pointing to the transcript path and locations; high-confidence findings still exit 3 (blocked).
- A reviewed item can be allowlisted and then no longer prompts.
- Location points the user to the right message in the transcript (test with a multi-message fixture); line numbers are included where implemented, otherwise the ticket notes record the deferral.
- Ticket note records the "replaced vs left in payload" audit and measured firing rate on real sessions.
- Existing flow/source tests still pass or are updated with equivalent assertions.
- `npm test`, `npm run typecheck`, `npm run build` pass.

