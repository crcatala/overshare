---
id: ass-tpao
status: closed
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


## Notes

**2026-10-03T04:23:00Z**

Field audit (verified against src/schema.ts, src/modes.ts, src/adapters/*, src/pipeline.ts), what the Redactor copies vs walks.
OUR OWN schema strings (copied, never user content): step id (for tool/subagent steps it is the harness call id, copied from the transcript), step responseId, step timestamp, step kind (tag), ToolStep.action (enum), EventStep.event (enum); turn timestamp; session-level schema, startedAt, endedAt, source.sessionId, source.leafId, generator.sharedAt, responses[].id, responses[].timestamp. Only the step fields are ever seen by redactSession.walk: turns are spread (index/timestamp/activity untouched), responses/source/startedAt/endedAt/generator are not walked at all (only title and project are), and no step contains a nested step (toolGroup, subagent usage/result, thinking summary, user.command have no id/kind/event/action keys). So the old SKIP_KEYS entries schema/sessionId/leafId/startedAt/endedAt/sharedAt were dead for the Redactor; they matter only for the re-scan.
FREE-FORM (walked, no key skipped): ToolStep.input (arbitrary harness JSON, any key names), ToolStep/SubagentStep result.text, EventStep.text/detail, TextStep/ThinkingStep text, ToolStep.name/summary/files, SubagentStep tool/agents/description/mode, toolGroup commands/files/calls[].name/responseIds, user text/command/expanded, project cwd/name/branch, title. Only ToolStep.input can hold arbitrary objects, so it is the one place where the old depth-agnostic skip bit. Not changed (out of scope): the step id of a tool call is copied from the transcript as the harness wrote it; a secret-shaped tool-use id is still only caught by the re-scan.
Design: OWN_STEP_FIELDS / OWN_TURN_FIELDS / OWN_SESSION_FIELDS in src/redact/index.ts are the single source; redactSession exempts a step string only directly on its key (not inside arrays or objects below it); rescan.ts uses the same sets by key path instead of guessing by dots/depth. No payload shape change, so no SCHEMA_VERSION bump.

**2026-10-03T04:23:22Z**

Real-session regression (counts only, knownSecrets: [], default config, own machine, modes full and brief, main 5d559c3 vs this branch, sessions over 12 MB skipped like in ass-iugy): 486 stable sessions (Claude Code + pi) + this repo's live transcript. Payload changed: 0 of 486 in both modes; strings changed: 0; new findings by rule: none; new suspicious: 0; newly blocked: 0. The live transcript grows between the two runs, so it was excluded from the sweep and compared on identical raw text instead: byte-identical payload on main and branch. Exposure: in full mode 131 strings in 23 of the 486 sessions sit under an id/action key inside a tool input (70 action, 61 id) and were previously skipped; they now go through the Redactor and none was altered (no ids mangled, no new noise). Brief mode has no such strings (input is dropped). Honest read: on this machine the gap was latent, not exploited; the fix is about the field name no longer deciding whether redaction applies.
