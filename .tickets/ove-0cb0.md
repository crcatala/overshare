---
id: ove-0cb0
status: open
deps: []
links: []
created: 2026-11-20T19:39:01Z
type: task
priority: 3
assignee: cc-vps
parent: ove-v5c6
---
# Codex: browse index freshness and speed for subagent rollouts

Review of PR #115 (ove-f0o0 part 1): (1) a cached browse row's subagent count (and the parent's summary) is not refreshed when a new child rollout appears later, since the parent file and its sidecar key do not change; (2) a cold index rebuild calls subagentRollouts per parent, each walking the whole rollout tree. Fix both with one child lookup per refresh (parent id -> children map built once per listing) and a descendant-aware cache key (e.g. include the child count/ids in the sidecar key). Impact today: browse counts can lag, and indexing is O(parents x rollouts) for users with many rollouts. report/export/publish are unaffected (they read children fresh).

