---
id: ove-ro4e
status: open
deps: [ove-zcms, ove-3b8f]
links: []
created: 2026-10-19T16:56:49Z
type: feature
priority: 3
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, betterleaks]
---
# Detect with Betterleaks high-confidence rules alongside secret-scan

Phase 2 of ove-2q2x. Load the high-confidence converted rules into `findSecretPatterns`, next to secret-scan's `scan()`. Their matches go through the existing filters (obviously-fake check, allowlist, placeholder) and overlap resolution at high confidence. Which rules are enabled is an explicit list of ids committed beside the JSON, so a later sync never turns a new rule on silently. Medium- and low-confidence rules are out of scope. With phase 1 this is the experiment the epic turns on: does Betterleaks catch anything on real sessions the current setup misses?

## Design

- Compile each rule once; lowercase the text once and skip a rule whose keywords are all absent. Keep the 32 KB chunking.
- Catastrophic backtracking: a fast-check property feeds each enabled rule long adversarial strings (its keywords repeated, near-miss bodies, long runs of its character classes) under a per-string time budget. Decide from that whether a linear-time engine (re2, re2-wasm) is needed; the default is no.
- Where a Betterleaks rule wins an overlap its id names the placeholder (`[REDACTED:github-pat]`); the allowlist matches values, so it is unaffected.
- Extend the planted-credential property's generator with a few formats only Betterleaks covers.

## Acceptance Criteria

audit:redaction against main shows findings by rule and the time cost (both in the PR); every new finding on real sessions is triaged by shape; the property suite passes at FC_NUM_RUNS=20000; full suite and typecheck pass on Node 22 and 24.

