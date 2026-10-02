---
id: ass-1c07
status: open
deps: []
links: [ass-5qv5]
created: 2026-10-02T20:05:57Z
type: task
priority: 3
assignee: cc-vps
tags: [redaction, security]
---
# redact: sanitize remaining untrusted metadata echoed in reports (sessionId, known-secret source)

Found while doing ass-5qv5. After that ticket, reports no longer print secret values, previews, finding context, or data-derived labels (key names, tool names, known-secret labels). A few smaller untrusted strings are still echoed verbatim:

- `ShareReport.sessionId` is read from the transcript (`sessionId` field / file) and printed in full in the `--json` report and 8 chars in the human header. It is metadata and skipped by content redaction (SKIP_KEYS), so a transcript whose session id is secret-shaped is echoed.
- Known-secret `source` (rendered in finding rules as `LABEL (source)`) can be a project `.env.*` file name from readdirSync, i.e. directory-controlled text. Credential-file sources are our own paths.
- Other `stats` strings keyed by data (model names in cache/subagent usage) are carried into the JSON report; verify they are identifier-shaped.

Fix: run these through `safeLabel` (src/redact/labels.ts) or an equivalent path-capable variant, with tests in the style of tests/report-leaks.vitest.ts. Low severity: none of these hold a secret in normal operation.

## Acceptance Criteria

Report (human and --json) never echoes sessionId, known-secret source, or data-keyed stats strings unless they pass the identifier check; regression tests planted with secret-shaped values.

