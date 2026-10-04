---
id: ass-ihnf
status: closed
deps: []
links: [ass-bfoq]
created: 2026-10-04T04:21:45Z
type: feature
priority: 3
assignee: cc-vps
tags: [browse, publish]
---
# browse: show the publish target in the dialog and let the user switch it (gist / R2)

Split from ass-bfoq. The CLI's publish takes -t/--target gist|r2; the browse TUI always publishes to the configured default (config.target, src/browse/source.ts:170), so the destination is only visible in the review summary (destinationLabel) and cannot be changed without leaving the TUI.

## Design notes
- Preselect the target the user has configured (config.target); the switch is an override for this publish only, never written back to config.
- Show the target in the publish dialog itself, not just the review text, and let it cycle between gist and r2.
- Preflight per target: an unconfigured target must explain what is missing (like refused modes), not crash and not be silently skipped. If only one target is configured the dialog still names it.
- Source.review must key on the target: the payload/review cache in src/browse/source.ts has to include it, so switching invalidates the cached review and what is reviewed is exactly what is uploaded (destination, warnings and the share record's target all follow the chosen one).
- The shares list records the target a share was published to (shares[k].target); keep that correct for an overridden target.

## Acceptance Criteria

The dialog names the target, preselected to the configured default; a key cycles it; the review summary, preflight warnings and the upload follow the chosen target; switching invalidates the cached review; an unconfigured target explains itself and blocks publish. Tests with the fake Source (target switch invalidates the review) and a publisher fake per target. npm test, npm run typecheck, npm run build pass.

