---
id: ove-mgjr
status: closed
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

Playbook steps: check the newest stable Betterleaks release (not a pre-release: 2.0.0 release candidates are out as of 2026-10-20) against `vendor/betterleaks/upstream.json`; if newer, fetch the rule file at that tag, record tag, commit and sha256 (a major release may change the file's format, which the converter must then follow); run the converter and review the JSON diff (rules added, removed, changed); list each new high-confidence rule in `betterleaks-enabled.json` under `enabled`, or under `excluded` with the reason when the audit or the backtracking tests give one (the test that fails on an undecided rule stays); prune any `token-formats.ts` entry the redundancy guard in `tests/token-formats.vitest.ts` now flags; run the tests, the property suite at a higher FC_NUM_RUNS, and audit:redaction against main; open a PR with a table of rule changes and the audit summary; never enable `validate`. When nothing is newer, say so and stop.

The playbook links to the "Betterleaks rules" section of `docs/development.md` for how the converter, `betterleaks-enabled.json` and the redundancy guard work, and does not restate it.

## Decisions (2026-10-20, owner)

- **Where it lives: both.** The steps are in `docs/maintaining-rules.md`. A short skill at `.agents/skills/sync-betterleaks/SKILL.md` (the shared Agent Skills location, which pi reads) tells an agent to follow that doc and holds no steps of its own. It is run only when asked, never picked by an agent on its own: its frontmatter sets `disable-model-invocation: true`, which pi and Claude Code both honour (pi runs it as `/skill:sync-betterleaks`). If Claude Code does not read `.agents/skills/`, a `.claude/skills/sync-betterleaks` symlink to the same folder, not a second copy.
- **Stable releases only.** Pre-releases are skipped.
- **New high-confidence rules: enable unless there is a reason not to.** The sync lists each under `enabled`, or under `excluded` with the reason, and the PR shows each with its audit result, so the owner can drop one at review. A new rule still never turns on by itself: the test that fails on an undecided rule stays.
- **No reminder.** The owner runs the sync by hand when they choose.
- **Renovate notifies only.** It tells the owner of a new stable Betterleaks release but never opens the update PR; the playbook does the sync. Mechanism: a custom regex manager on `vendor/betterleaks/upstream.json` (`github-releases` datasource, `betterleaks/betterleaks`), with `dependencyDashboardApproval`, so the release appears on the Dependency Dashboard and no PR opens unless approved there.

## Acceptance Criteria

- The playbook exists in `docs/maintaining-rules.md`, linked from the README's docs table, and links to `docs/development.md` rather than restating it.
- The skill at `.agents/skills/sync-betterleaks/SKILL.md` points at the playbook, holds no steps, and sets `disable-model-invocation: true`. Whether Claude Code reads `.agents/skills/` was checked, and a `.claude/skills/` symlink added if it does not.
- Renovate is set as above: Betterleaks releases on the Dependency Dashboard, no PR without approval.
- An agent following the playbook on the then-current state either reports up to date (pre-releases skipped) or produces a PR that meets the steps.


## Notes

**2026-10-21T02:33:14Z**

Done: the playbook is docs/maintaining-rules.md (linked from the README's docs table and from development.md's Betterleaks rules section, which it links to rather than restating). The sync-betterleaks skill at .agents/skills/ only points at it and sets disable-model-invocation: true. Claude Code's skills docs list only .claude/skills/ locations, so .claude/skills/sync-betterleaks is a symlink to the same folder; a headless /sync-betterleaks run loaded it through the symlink. Renovate: a custom regex manager on upstream.json's tag (github-releases, betterleaks/betterleaks, semver, ignoreUnstable) with dependencyDashboardApproval and automerge off. config:recommended ignores **/vendor/**, so ignorePaths repeats its list without it. A local lookup dry run found the dependency, offered v1.9.0 from v1.8.1 (not the 2.0.0 RCs) with approval required, and nothing at v1.9.0. Dry run of the playbook on 2026-10-20: v1.9.0 vendored and newest stable (v2.0.0-rc.1 to rc.4 skipped), so up to date. It showed that a failed gh call could be read as up to date; step 1 now accepts only vX.Y.Z tags and says never to take an empty result as up to date.
