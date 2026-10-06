---
id: ove-gqx6
status: open
deps: []
links: [ove-irp5]
created: 2026-10-06T04:12:28Z
type: bug
priority: 3
assignee: cc-vps
tags: [viewer, tokens, robustness, compat]
---
# Viewer: a share with malformed session stats or usage records fails with a raw TypeError

## Problem

Found while scoping the malformed-tool-group fix (probe on main @ 9556a64). Session-level fields are read without checks, so a share where they are missing or the wrong type crashes rendering, and the page shows a raw JavaScript error instead of a useful message:

- `stats.tools = null` → rail: `Cannot convert undefined or null to object`
- `stats.files = null` → rail: `Cannot read properties of null (reading 'read')`
- `stats.tokens = null` → rail: `Cannot read properties of null (reading 'input')`
- a `responses[]` entry with no `usage` or `usage: null` → rail: `Cannot read properties of … (reading 'input')`
- a `responses[]` entry that is `null` → transcript: `Cannot read properties of null (reading 'turn')`

The header reads the same stats, so guarding only the rail is not enough.

## Options

- Normalize these in `viewer/src/compat.ts` (`readShare`), next to the existing turn/step filtering: drop response entries that aren't objects with a usage object, default missing stats from the turns/responses or to zeros.
- Or reject structurally broken shares there with a clear message ("This share is damaged: …").
- Separately, consider rendering the rail inside a try/catch in `main.ts` with a "token figures couldn't be shown" fallback, so a rail bug never takes the transcript down.

## Impact

Low: overshare never writes these shapes. Same threat model as the tool-group ticket (crafted, corrupted or future-format shares).

