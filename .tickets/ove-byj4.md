---
id: ove-byj4
status: closed
deps: [ove-ro4e]
links: []
created: 2026-10-19T16:56:49Z
type: chore
priority: 3
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, betterleaks]
---
# Prune hand-written formats Betterleaks covers; decide on secret-scan

Phase 3 of ove-2q2x. Remove the `TOKEN_FORMATS` entries in `src/redact/token-formats.ts` that an enabled Betterleaks rule now covers. Keep what is overshare's own: the AWS secret key found next to its key id, auth headers, `curl -u`, assignments, URL credentials, the wrapped-JWT and truncated-key handling, and the placeholder and fake checks. Then run audit:redaction with each source on its own to list what only secret-scan finds; if nothing (or only what can be ported), remove `@sanity-labs/secret-scan` and `TRUSTED_RULES`.

## Acceptance Criteria

Each removed format names the Betterleaks rule that covers it, and its test in token-formats.vitest.ts still passes (assertions on rule names updated); audit:redaction shows no lost findings; the decision on secret-scan, with the source-by-source audit, is recorded in the PR.


## Notes

**2026-10-20T15:50:55Z**

Done: only slack-app-token was pruned. Every other token-formats.ts entry still finds a token Betterleaks' rules miss: most Betterleaks rules have the provider's exact length (a longer token leaves its tail) and end only before whitespace, a quote or ';' (a token before ',', ')', '.' or '&' is missed); pypi-token also covers TestPyPI, azure-storage-key a key without '=='. tests/token-formats.vitest.ts now fails when an entry becomes redundant after a sync: remove it and mark its cases coveredBy. secret-scan stays, pending a decision (the hard rule for these runs: no dependency removal without the owner). Source-by-source audit over 725 local sessions: with secret-scan off, full mode loses 137 redactions in 54 sessions (35 sessions go from review to clean), brief 7 in 3; all but 5 are its generic medium rules, mostly false positives (tool/message ids, code, JSON); the 5 high ones are placeholder connection strings, a regex and one short JWT the re-scan still flags. No TRUSTED_RULES provider rule names a finding any more. If it goes: port shannonEntropy (4 imports) and drop TRUSTED_RULES. For phase 4 (sync playbook): rerun the redundancy test and the backtracking test after each sync.

**2026-10-20T16:53:10Z**

After review: nothing is pruned. slack-app-token is back: Betterleaks' xapp- rule runs on into text glued to the token, and its wider match is dropped as obviously fake (a token glued to 'xxxxxxxx' or 'EXAMPLE' was published, re-scan silent). The redundancy guard now requires a Betterleaks match of exactly the token's span and also tries a glued placeholder run; the coveredBy mechanism is gone (no entry is removed). Pre-existing on main since #77: a token only Betterleaks finds, glued to fake-looking text, is dropped the same way.
