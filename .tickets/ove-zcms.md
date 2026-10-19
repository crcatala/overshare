---
id: ove-zcms
status: closed
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


## Notes

**2026-10-19T17:48:23Z**

Done: npm run audit:redaction (scripts/audit-redaction.ts). For the next phases: run `npm run audit:redaction -- --base main --shape changed` on the branch. A full run over ~720 local sessions takes about 23 min (base and working tree in turn), so use --limit or --mode for quick checks and the full run for the PR. Results are saved in out/audit-redaction/, and --from re-prints them without rerunning. The summary flags any session that got at least 0.5s and 50% slower (the backtracking check for phase 2). --shape covers findSecretPatterns only, which is where the Betterleaks rules plug in. If phase 2 adds a dependency, the base worktree uses this checkout's node_modules, so install before running. Baseline on main 929d96a: no differences between main and itself; brief 117s, full 560s per side.
