---
id: ass-iugy
status: closed
deps: [ass-5qv5]
links: [ass-13r0, ass-azwt, ass-5qv5, ass-8w1o, ass-jgn2, ass-tpao]
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


## Notes

**2026-10-03T02:21:30Z**

Audit (replaced vs left in payload), verified against the real pipeline, counts only. Redactor.redactText replaces EVERY findSecretPatterns match, medium included (secret-assignment, generic keyword rules, sensitive-key values): 62 medium findings across 53 real local sessions were all replaced, none left behind. What stays in the outgoing bytes and can still match at medium confidence: (1) object KEYS: redactSession.walk never redacts keys, rescan collectStrings does scan them; (2) values under SKIP_KEYS (id, sessionId, kind, ...), which are deliberately skipped by the Redactor; (3) strings that only become a match after a later transform (rare). So the suspicious tier = medium-confidence rescan of the final payload. Of these, SKIP_KEYS ids are identifiers (e.g. tool-use ids) and generic rules fire on them: 1 of 53 real sessions hit a medium rule on a step id. Decision: the suspicious tier ignores SKIP_KEYS values (high-confidence matches there still block). Known blind spot, as the ticket says: a secret with no recognizable format matches nothing and is not covered by this tier.

**2026-10-03T02:29:01Z**

Firing rate on real local sessions (counts only, knownSecrets=[] so nothing harvested, own machine): 486 sessions (Claude Code + pi; 15 files over 12 MB skipped), modes full and brief: suspicious tier fired on 0 of 486 in both modes (full: 410 clean, 76 needs-review for redacted secrets, 0 blocked; brief: 470 clean, 16 needs-review). Without the SKIP_KEYS (identifier) exemption it would have fired on 6 of 478 (1.3%), all one generic rule (eightxeight-2) on step ids, i.e. pure noise, which is why identifiers are exempt. 311 medium findings across those sessions were replaced by the Redactor and none remained. Conclusion: no confirmation fatigue; the tier is a rare backstop (object keys and fields outside the walked strings), not a frequent prompt, and no tightening was needed. Honest limit: it surfaces only what a pattern layer matched at medium confidence; secrets with no format stay invisible (that is what known-value harvesting is for).

**2026-10-03T02:29:01Z**

Design decisions: (1) --yes needs a NEW explicit flag --allow-suspicious (not --allow-findings): --allow-findings means 'secrets were redacted and are not in the payload'; suspicious values ARE still in the payload, and wrappers that routinely pass --allow-findings (pi extension, skill) must not silently cover them. (2) Exit codes unchanged: suspicious + no confirmation = 2 (needs review); high-confidence = 3. (3) Location phase 1: turn number (1-based, as in browse viewer) + step (tool name via safeLabel) + field path, plus the transcript path printed by CLI/browse. Turn numbers in finding 'where' were 0-based while the browse viewer is 1-based; changed 'where' to 1-based so both agree. (4) High-confidence rescan issues also carry the location now (same walker). (5) Phase 2 (source JSONL line numbers) deferred: needs provenance carried from parseSession through projectSession/redactSession; see follow-up ticket. (6) Browse: extra 'suspicious' step needs an explicit c (enter/y do nothing), then the usual y; Source.publish refuses suspicious payloads unless suspiciousConfirmed is passed. (7) Dedupe by value: one item per distinct value, first location, occurrence count.

**2026-10-03T02:29:12Z**

Phase 2 (source line numbers) split out as ass-jgn2

**2026-10-03T02:35:53Z**

Final scope of the identifier exemption (after self-review): the Redactor skips SKIP_KEYS (id, kind, ...) at ANY depth, including inside tool inputs, so exempting those keys everywhere in the re-scan would hide real content (a tool input {"id": "password=..."}). The re-scan therefore exempts them only (a) directly on a turn/step object and (b) at any depth in session-level schema fields (responses[].id). Measurement above was re-run with exactly this final code: 0 of 486 sessions in both modes (it fired once, on responses[].id, before rule (b)). Pre-existing gap noticed, not changed here: the Redactor's depth-agnostic SKIP_KEYS means an 'id'/'kind'/'event'/'action'-named field inside tool input is never redacted; high-confidence matches there still block at the re-scan.

**2026-10-03T02:36:00Z**

Pre-existing SKIP_KEYS depth gap filed as ass-tpao
