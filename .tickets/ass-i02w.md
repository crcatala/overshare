---
id: ass-i02w
status: open
deps: []
links: []
created: 2026-10-04T03:33:38Z
type: bug
priority: 4
assignee: cc-vps
tags: [redact, stats]
---
# A transcript-supplied key named __proto__ is lost from records built with bracket assignment (stats.rates, byModel, safeKeys)

Found reviewing the ass-gmih/ass-lka8 PR. rates[m.model] ??= {} in src/adapters/pi.ts (and the byModel / tools builders in stats and claude-usage, and safeKeys in src/redact/labels.ts) assign by bracket, so a model or tool named __proto__ sets the record's prototype instead of an own key and the entry vanishes: a pi model named __proto__ has no stats.rates entry on main. Redactor.redactIdentifierKeys already builds with Object.fromEntries and is not affected.

## Acceptance Criteria

A model or tool named __proto__ keeps its entry in stats.rates, stats.tools, subagentUsage.byModel and the report copies; covered by a test per site.

