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
tags: [redaction, betterleaks, needs-decision]
---
# Playbook for syncing with the latest Betterleaks rules

Phase 4 of ove-2q2x. **Needs a product decision before work starts.** Preference so far (2026-10-19): no automation. Instead, a playbook in the repo that an agent can follow when asked to "sync with the latest Betterleaks rules as best you can, and open a PR if anything changed", run by hand every now and then. Renovate (already set up) could open update PRs instead; that is the option not taken for now.

## Design

Playbook steps: check the newest Betterleaks release against `vendor/betterleaks/upstream.json`; if newer, fetch the rule file at that tag, record tag, commit and sha256; run the converter and review the JSON diff (rules added, removed, changed); decide which new high-confidence rules to enable, noting each; run the tests, the property suite at a higher FC_NUM_RUNS, and audit:redaction against main; open a PR with a table of rule changes and the audit summary; never enable `validate`. When nothing is newer, say so and stop.

Open decisions:
- Where it lives: `docs/maintaining-rules.md`, a project skill under `.claude/skills/` that an agent loads by name, or both (a skill that points at the doc).
- Stable releases only, or pre-releases too.
- New high-confidence rules on by default, or off until reviewed.
- Whether to add a reminder of some kind, or leave the cadence entirely manual.
- Whether Renovate should later be used just to notify of releases, not to open PRs.

## Acceptance Criteria

The decisions above are recorded on this ticket; the playbook exists where decided; an agent following it on the then-current state either reports up to date or produces a PR that meets the steps.

