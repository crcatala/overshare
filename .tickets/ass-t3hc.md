---
id: ass-t3hc
status: closed
deps: []
links: [ass-jgn2]
created: 2026-10-03T23:44:40Z
type: bug
priority: 3
assignee: cc-vps
tags: [redaction, security]
---
# redact: transcript-supplied entry types are published as keys of redaction.dropped

Found while testing ass-jgn2. The adapters count dropped native entries by a key built from transcript data (claude-code.ts: `bump(dropped, e.type)`, `attachment:${a.type}`, `system:${e.subtype}`, `origin:${kind}`; pi.ts: `custom:${e.customType}`, `${e.type}`), and pipeline.ts publishes the record as session.redaction.dropped in every mode. The Redactor never walks object keys, so a transcript line whose type is secret-shaped (e.g. a github token) reaches the payload as a key; the final re-scan then blocks it (high confidence) or flags it as suspicious (medium), but nothing redacts it first. Fix: pass the keys through safeKeys/safeLabel (as reportStats does for model ids). Note tests/source-lines.vitest.ts uses this as its every-mode finding vehicle: when fixed, plant the value elsewhere that every mode keeps.

## Acceptance Criteria

A secret-shaped entry type or subtype never appears in the payload or report; ordinary types (attachment:queued_command, system:turn_duration) are unchanged; tests/source-lines.vitest.ts matrix moved to another vehicle.

