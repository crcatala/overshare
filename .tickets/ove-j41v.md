---
id: ove-j41v
status: open
deps: []
links: []
created: 2026-10-06T05:02:38Z
type: bug
priority: 1
assignee: cc-vps
tags: [claude-code, privacy, branches]
---
# Claude adapter: a rewind that discards most of a session exports the discarded branch

Found while reviewing PR #62 (opt-in system prompt). branchEntries (src/harnesses/claude-code/parse.ts) falls back to every entry in file order when the branch from the leaf holds less than half the session's conversational entries, a heuristic from the first spike (6e394dc) meant for a broken parent chain. A legitimate rewind that discards a longer branch than it keeps trips it, and the discarded branch's prompts, replies and tool output are then exported, in every share mode. Repro: one turn, then four turns, then rewind to after the first turn and add one turn: parseClaudeCode returns all six turns. The same fallback applies when an explicit --leaf id is not found (returns every entry). PR #62 made the system prompt immune (it is read from the leaf's parent chain), but the conversation itself is not. Related: ass-wwnx notes the same file-order limitation in browse previews.

## Design

Tell a broken chain apart from a rewind before falling back: a rewind leaves the discarded entries on a valid chain of their own that forks from an ancestor of the leaf, while a broken chain has entries whose parent is missing. Fall back only for the latter, or never fall back and report entries that are not on the branch. An unknown --leaf should be an error, not every entry. Check how often the fallback fires on real local sessions before choosing.

## Acceptance Criteria

A rewind that discards the longer branch exports only the kept branch (test with the scenario above); an unknown --leaf fails with a clear error; existing broken-chain behaviour is covered by a test, and the choice for it is documented.

