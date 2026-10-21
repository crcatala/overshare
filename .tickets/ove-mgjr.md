---
id: ove-mgjr
status: open
deps: [ove-3b8f]
links: []
created: 2026-10-19T16:56:49Z
type: chore
priority: 4
assignee: cc-vps
parent: ove-2q2x
tags: [redaction, betterleaks]
---
# Playbook for syncing with the latest Betterleaks rules

Phase 4 of ove-2q2x. Decided 2026-10-20 (see Decisions below): no automation. Instead, a playbook in the repo that an agent can follow when asked to "sync with the latest Betterleaks rules as best you can, and open a PR if anything changed", run by hand every now and then. Renovate (already set up) could open update PRs instead; that is the option not taken for now.

## Design

Playbook steps: check the newest Betterleaks release against `vendor/betterleaks/upstream.json`; if newer, fetch the rule file at that tag, record tag, commit and sha256; run the converter and review the JSON diff (rules added, removed, changed); enable new high-confidence rules, noting each; prune any `token-formats.ts` entry the redundancy guard in `tests/token-formats.vitest.ts` now flags (a new Betterleaks rule covers it); run the tests, the property suite at a higher FC_NUM_RUNS, and audit:redaction against main; open a PR with a table of rule changes and the audit summary; never enable `validate`. When nothing is newer, say so and stop.

## Decisions (2026-10-20, owner)

- **Where it lives: both.** The steps are in `docs/maintaining-rules.md`. A short skill at `.agents/skills/sync-betterleaks/SKILL.md` (the shared Agent Skills location, which pi reads) tells an agent to follow that doc. Check whether Claude Code reads `.agents/skills/`; if not, add a `.claude/skills/sync-betterleaks` symlink to the same folder rather than a second copy.
- **Stable releases only.** Pre-releases are skipped.
- **New high-confidence rules are on by default.** The PR lists each one with its audit result, so the owner can drop one at review.
- **No reminder.** The owner runs the sync by hand when they choose.
- **Renovate notifies only.** It may tell the owner of a new Betterleaks release, but never opens the update PR; the playbook does the sync.

## Acceptance Criteria

The playbook exists in `docs/maintaining-rules.md`, with the skill pointing at it; Renovate is set to notify of Betterleaks releases without opening PRs; an agent following it on the then-current state either reports up to date or produces a PR that meets the steps.

