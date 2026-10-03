---
id: ass-1c07
status: open
deps: []
links: [ass-5qv5, ass-tpao]
created: 2026-10-02T20:05:57Z
type: task
priority: 3
assignee: cc-vps
tags: [redaction, security]
---
# redact: treat transcript-supplied identifiers as untrusted (report echoes, payload step ids)

Found while doing ass-5qv5. After that ticket, reports no longer print secret values, previews, finding context, or data-derived labels (key names, tool names, known-secret labels). A few smaller untrusted strings are still echoed verbatim:

- `ShareReport.sessionId` is read from the transcript (`sessionId` field / file) and printed in full in the `--json` report and 8 chars in the human header. It is metadata and skipped by content redaction (SKIP_KEYS), so a transcript whose session id is secret-shaped is echoed.
- Known-secret `source` (rendered in finding rules as `LABEL (source)`) can be a project `.env.*` file name from readdirSync, i.e. directory-controlled text. Credential-file sources are our own paths.
- Other `stats` strings keyed by data (model names in cache/subagent usage) are carried into the JSON report; verify they are identifier-shaped.

Payload side (added from ass-tpao): a step's `id` (for tool and subagent steps it is the harness call id, copied from the transcript) and `responseId` are own fields that the Redactor copies as they are (`OWN_STEP_FIELDS` in `src/redact/index.ts`). A secret-shaped call id therefore reaches the uploaded bytes and only the final re-scan can catch it: high-confidence matches block, medium ones are exempt from the suspicious tier on purpose (generic rules fire on ids). Same root cause as above, transcript-supplied identifiers treated as trusted, on a different surface. Fix direction: run step `id`/`responseId` through the pattern and known-value rules only (not the email/home-path/username rules that could mangle ids), and check on real sessions that ids like `toolu_...` are not touched (ass-tpao measured 0 findings on 486 real sessions with the current exemption, so expect no change there). Test with a planted secret-shaped call id for both harnesses.

Fix: run these through `safeLabel` (src/redact/labels.ts) or an equivalent path-capable variant, with tests in the style of tests/report-leaks.vitest.ts. Low severity: none of these hold a secret in normal operation.

## Acceptance Criteria

Report (human and --json) never echoes sessionId, known-secret source, or data-keyed stats strings unless they pass the identifier check; a secret-shaped step id or responseId is redacted in the payload (both harnesses, real pipeline); regression tests planted with secret-shaped values.

