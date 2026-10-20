---
id: ove-ro4e
status: closed
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


## Notes

**2026-10-20T01:41:08Z**

Done: src/redact/betterleaks.ts runs the 342 rules src/redact/betterleaks-enabled.json enables (43 high-confidence rules excluded, each with its reason) beside secret-scan; its matches come first, so a Betterleaks id names the placeholder on a tie. For phase 3: (1) Many Betterleaks rules have an exact length (github-pat ghp_+36, gitlab-runner-authentication-token glrt-+20) where token-formats.ts uses lower bounds and runs to the end of the token: pruning a hand-written format whose Betterleaks rule is exact-length would leave the tail of a longer token. Some have no leading boundary either (glrt- matches inside a word). Compare each before removing it. (2) The audit's label changes show which secret-scan rules no longer name any finding on real sessions (github-v2, aws-access_keys, stripe, xai, openrouter, pypi, privatekey, slackwebhook, google via token-formats): the start of the "does secret-scan stay" question. (3) Backtracking: the converter writes Go's (?:.|[\n\r]) as [\s\S]; curl-auth-header is excluded; tests/betterleaks-backtracking.vitest.ts times every enabled rule (worst under 50 ms on a 40 KB window), so no linear-time engine is needed. Rerun it after enabling more rules. (4) The keyword index assumes keywords are lowercase ASCII of 3+ characters; a test fails if a sync breaks that. (5) Audit over 723 local sessions: brief +4.2% time, full +6.9%; full mode 1 session blocked -> review; findings 667 -> 696, mostly relabels.

**2026-10-20T13:29:34Z**

After review: (6) A rule without a value group now redacts group 1 only when group 1 holds every other group, else the whole match (jwt-base64 and microsoft-teams-webhook redacted only a piece of the token before). (7) temporal-cloud-api-key.1 is excluded (polynomial backtracking; jwt covers Temporal keys), and the backtracking test also checks each regex statically for two overlapping unbounded runs around a literal, since adversarial strings cannot reach a slow part behind a required prefix. Its timing runs in a child process killed after a timeout, so a hang fails the test with the rule's name. (8) The converter merges adjacent greedy repeats of one class (alibaba-sts-security-token took 1.3 s per window). (9) The rule table carries Betterleaks' MIT license (a 'license' field), checked in the package smoke test.
