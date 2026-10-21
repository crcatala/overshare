---
name: sync-betterleaks
description: Sync overshare's vendored Betterleaks rules with the newest stable Betterleaks release, and open a PR if anything changed. Run only when the owner asks.
disable-model-invocation: true
---

# Sync with Betterleaks

Follow `docs/maintaining-rules.md` at the repository root, from step 1, and do what it says. Every step is
there; this skill has none of its own. If Betterleaks has no stable release newer than the vendored one, the
playbook says to report that and stop.
