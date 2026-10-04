---
id: ass-gmih
status: closed
deps: []
links: []
created: 2026-10-04T00:16:18Z
type: bug
priority: 3
assignee: cc-vps
tags: [redaction, security]
---
# redact: model ids are published unredacted (session.models, stats byModel/rates keys)

Found while moving tests/source-lines.vitest.ts off redaction.dropped (ass-t3hc). The Redactor walks title, project, responses ids and turns only, so a secret-shaped model id in a transcript reaches the payload as session.models[n] (a value) and as a key of stats.rates / stats.subagentUsage.byModel, in every mode. The final re-scan blocks a high-confidence one and flags a medium one as suspicious, but nothing redacts it first; reportStats already safeKeys the report copy, the published payload keeps session.stats as it is. tests/source-lines.vitest.ts now uses session.models as its every-mode finding vehicle: when fixed, plant the value elsewhere that every mode keeps.

## Acceptance Criteria

A secret-shaped model id never appears in the payload or report; ordinary ids (claude-opus-5-5) are unchanged; tests/source-lines.vitest.ts matrix moved to another vehicle.

