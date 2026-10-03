---
id: ass-tpao
status: open
deps: []
links: [ass-iugy]
created: 2026-10-03T02:36:00Z
type: bug
priority: 3
assignee: cc-vps
tags: [redaction, security]
---
# redact: SKIP_KEYS skips id/kind/event/action-named fields at any depth, including inside tool input

Found while implementing ass-iugy. In src/redact/index.ts, redactSession's walk skips every string whose KEY is in SKIP_KEYS (schema, id, responseId, timestamp, kind, event, action, sessionId, leafId, startedAt, endedAt, sharedAt) at any depth, not only on our own turn/step objects. A tool input or result JSON object that happens to have an 'id', 'kind', 'event' or 'action' property therefore never has its value redacted: e.g. a tool input {"id": "password=<secret>"} or {"action": "<secret>"} goes out as is. Recognizable secrets are still caught: the final re-scan blocks high-confidence matches and known values anywhere in the payload, and ass-iugy reports medium-confidence matches as suspicious (except for identifier fields directly on turns/steps and session-level schema fields). Not caught: a secret with no recognizable format in such a field (no pattern matches it), and anything that only the Redactor's sensitive-key and known-value replacement would have handled. The Redactor itself should replace values there instead of leaving them for a block or a confirmation.

Fix direction: apply SKIP_KEYS only to our own schema fields (top level of a turn/step/session), and walk free-form content (tool input, tool result, event detail) without skipping any key. Check tests/redact.vitest.ts and the adapters for which fields actually need skipping so ids/timestamps are not mangled by the email/home-path/username rules.

Why it matters: a user-controlled field name picks whether redaction applies.

## Acceptance Criteria

A secret under an 'id'/'kind'/'event'/'action' key inside a tool input is redacted; own ids and timestamps are unchanged; test with the real pipeline.

