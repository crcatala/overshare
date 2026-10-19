---
id: ove-byj4
status: open
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

