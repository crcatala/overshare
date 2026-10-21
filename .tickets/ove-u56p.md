---
id: ove-u56p
status: closed
deps: [ove-byj4]
links: []
created: 2026-10-20T17:23:21Z
type: chore
priority: 3
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, betterleaks]
---
# Remove @sanity-labs/secret-scan; Betterleaks and our own rules detect alone

Follow-up to ove-byj4 (PR #78), and the epic's stated end: Betterleaks' rules plus overshare's own (token-formats.ts, the context rules in patterns.ts) as the only secret-shape detection. The source-by-source audit in #78 (725 local sessions) found that no secret-scan provider rule in TRUSTED_RULES names a finding any more, and that what secret-scan alone finds is mostly its generic keyword rules matching non-secrets (tool-call and message ids, code, JSON). Those false alarms mark 35 full-mode sessions 'needs review' (3 in brief). Two values it alone finds could not be classified by shape (a 32-char upper+digit value near the word 'secret' in 11 sessions; a 27-char value in a command near 'token'), plus one short JWT the re-scan still flags without it.

## Design

First, the owner checks the two values (npm run audit:redaction -- --from out/audit-redaction/secret-scan-only --shape changed, on #78's branch, while the local audit-tmp/* branches exist; otherwise rerun against a ref with scan() returning nothing). If one is a real credential, rotate it and port its shape into our own rules (secret-assignment or token-formats.ts) before removing anything. Then: write shannonEntropy in src/redact (4 modules import it from secret-scan; same definition, so thresholds don't move), remove scan() and TRUSTED_RULES from patterns.ts and the dependency from package.json, update the patterns.ts and docs/redaction.md descriptions and any test that names a secret-scan rule. CHANGELOG: fewer false 'needs review' results.

## Acceptance Criteria

@sanity-labs/secret-scan is gone from package.json and src/; shannonEntropy gives the same values as before (a test); audit:redaction --base main loses only the generic medium findings (and the high ones the #78 triage called placeholders or false positives), each triaged by shape in the PR; the two unclassified values are decided by the owner first; full suite, typecheck, property suite at FC_NUM_RUNS=20000 and Node 22.19 pass.


## Notes

**2026-10-20T18:57:53Z**

Done: @sanity-labs/secret-scan is gone. Owner decided first (2026-10-20) that the two unclassified values from #78 are not live; investigated by shape: the 32-char value is the age-key character set and the 27-char one the TestPyPI test prefix, both committed in tests. shannonEntropy lives in src/redact/entropy.ts (same definition, pinned by tests/entropy.vitest.ts). Removing the library as designed would have lost 12 providers (Anthropic, OpenAI, Stripe, Groq, Replicate, SendGrid, npm, Postman, Hugging Face, DigitalOcean, xAI, single-line JWT) before ',' ')' '.' or '&', since Betterleaks' rules end only at whitespace, a quote or ';'. The owner chose to port them: 11 new token-formats.ts entries, and the JWT rule now also takes a JWT on one line. For phase 4 (sync playbook): if the converter ever relaxes Betterleaks' trailing boundary, the redundancy guard in tests/token-formats.vitest.ts will flag many entries (old and new) for pruning. audit:redaction against a ref that still imports a removed dependency needs it installed with npm install --no-save (docs/development.md).

**2026-10-20T20:01:39Z**

Also found by the property suite at FC_NUM_RUNS=20000: an AKIA key id whose entropy is at most 3 bits (repeated characters) is dropped by Betterleaks' aws-access-token entropy bar, and secret-scan had trusted the format. token-formats.ts has an aws-access-key-id entry at the fixed length with no randomness check (so 12 new entries in all, plus single-line JWTs).
