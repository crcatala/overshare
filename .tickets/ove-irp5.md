---
id: ove-irp5
status: closed
deps: []
links: [ove-gqx6]
created: 2026-10-06T04:12:28Z
type: bug
priority: 3
assignee: cc-vps
tags: [viewer, tokens, robustness]
---
# Token rail: a malformed tool group stops the whole session loading

## Problem

Shares are untrusted (anyone can publish a gist and send a viewer link). The transcript tolerates a malformed step: it shows that turn as a "couldn't be shown" placeholder and renders the rest, as docs/viewer.md promises. The token rail does not: it reads tool-group fields at render time with no guard, so the error escapes `renderTokenRail()` and `main()` replaces the whole session with an error page.

Found while reviewing PR #59 (which fixed the same problem for `responseIds`). Predates that PR.

## Reproduction (probe on main @ 9556a64)

A brief-mode share with one `toolGroup` step where:

- `calls` is `null`, a number, a string or an object → `g.calls.filter is not a function` (via `shellBreakdown()` → `groupShell()`)
- `calls` holds a non-object (`[null]`) → `Cannot read properties of null (reading 'name')`
- `commands` is `null` → `Cannot read properties of null (reading 'length')`
- `commands` holds a non-string (`[null]`) → crashes in `tallyCommands()`

Tool steps (`name`/`summary`/`input` of the wrong type) and subagent steps were probed too and do not crash the rail.

## Impact

Low. overshare always writes these fields as lists, so normal shares never hit it. A crafted, hand-edited or future-format share fails to display at all instead of losing one turn. No script execution or data exposure.

## Acceptance Criteria

- A share with any of the malformed tool groups above renders: the transcript shows its placeholder, the rail renders with the rest of its figures.
- The rail's per-step readers (shell breakdown, the model-call card's activity list) skip a step they can't read instead of throwing, like the transcript does.
- Regression tests cover each malformed shape.


## Notes

**2026-10-06T04:16:54Z**

Fixed on fix/rail-malformed-tool-group: shellBreakdown() reads each step inside a try (a step it can't read is left out, as the transcript shows it as a placeholder) and counts only string commands under a string tool name; stepActivity() turns a step it can't read into a 'couldn't be shown' line, so the model-call card still opens. Regression tests: one per malformed shape above, plus a card test (thinking step with non-string text: the transcript keeps the turn, the old card threw). Session-level shapes (stats, usage records) split out to ove-gqx6.
