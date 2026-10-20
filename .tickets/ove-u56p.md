---
id: ove-u56p
status: open
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

