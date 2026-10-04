---
id: ass-bfoq
status: open
deps: []
links: [ass-ihnf]
created: 2026-10-01T21:13:55Z
type: feature
priority: 3
assignee: cc-vps
tags: [browse, publish]
---
# browse: CLI parity for publish options (--secrets-file, pi --leaf)

Follow-up from PR #21 (follow-up item 7).

## Problem
agent-share publish supports options the browser publish dialog does not:
- --secrets-file <file...>: extra values to redact (src/cli.ts, readSecretsFile -> extraKnownSecrets in prepareShare).
- --leaf <entryId>: publish a chosen branch of a tree-shaped pi session.
Users who need these must leave the browser and re-find the session in the CLI.

## Design notes
- Two separable pieces now; split into subtasks if scope grows. Each must flow through Source.review so what is reviewed is exactly what is uploaded (payload cache key in src/browse/source.ts must include the new inputs).
- Target switch: split out to ass-ihnf.
- --leaf: needs a branch picker in the viewer or dialog for sessions with branches; hide it when the session has a single branch.
- secrets file: a path field or a config/env default (AGENT_SHARE_SECRETS?) rather than free-text per publish; decide at implementation.
- Out of scope: bulk actions, delete and open-link-in-browser in the browser (delete tracked with ass-1rgj).

## Acceptance
- Each option is reachable from the publish flow, appears in the review summary, and changing it invalidates the cached review.
- Tests with the fake Source plus real-pipeline tests for each option (planted secret from file is redacted; leaf selects the right branch).
- npm test, npm run typecheck, npm run build pass.


## Notes

**2026-10-04T04:21:50Z**

Target switch split into ass-ihnf (the one that is clearly worth having in the TUI; preselects the configured default). What is left here, --secrets-file and pi --leaf, is lower value: reconsider whether either is wanted in the TUI before starting.
