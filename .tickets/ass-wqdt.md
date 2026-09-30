---
id: ass-wqdt
status: closed
deps: []
links: []
created: 2026-09-30T00:49:49Z
type: bug
priority: 1
assignee: cc-vps
---
# Prevent pi template expansions leaking through prompts shares

Record verified pre-expansion authored input in the pi integration, bind it to its native user message, and fail closed for unverified pi prompts exports/projections. Add exported-prompt regression checks against pi fixtures and integration/provenance edge cases.

