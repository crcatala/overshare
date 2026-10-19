---
id: ove-zcms
status: open
deps: []
links: []
created: 2026-10-19T16:56:48Z
type: task
priority: 2
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, tooling]
---
# audit:redaction: compare redaction across local sessions between two refs

Phase 0 of ove-2q2x, and worth doing without the rest. Turn the throwaway comparison used for PR #73 into `scripts/audit-redaction.ts` and `npm run audit:redaction`. It runs `prepareShare` (brief and full) over every local Claude Code and pi session, once at a base ref and once on the working tree, with no known values read, and reports: status changes per mode, per-rule finding deltas with the number of sessions, which sessions changed (by file, never content), errors, and time per mode. For PR #73 it found two real credentials `main` would have published, in two real sessions, and showed nothing else changed; every later phase of the epic is judged by it. Local only, like `audit:usage`: it needs the machine's real sessions.

## Design

Base ref in a temporary git worktree with `node_modules` symlinked, its `src/` imported through tsx, so both sides run the same harness. Keep each side's results as JSON so a comparison can be redone without rerunning. An optional `--shape <file>` describes each finding the head has and the base does not by shape only (rule, key name if it is a plain identifier, length, character classes, whether its quotes were escaped, whether it starts with a placeholder word), the way the two real finds in #73 were triaged without printing them. The session file being written while the audit runs keeps growing, so label it (or skip it) rather than reporting it as a change.

## Acceptance Criteria

`npm run audit:redaction -- --base main` prints the summary and exits 0; a test plants a fake credential and checks that nothing the audit prints (summary or `--shape`) contains it or a fragment of it; documented in docs/development.md next to the property tests.

