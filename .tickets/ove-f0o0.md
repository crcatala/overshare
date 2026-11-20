---
id: ove-f0o0
status: in_progress
deps: [ove-m3y1]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-v5c6
tags: [harness, codex]
---
# Codex: subagents, compaction, .jsonl.zst and continuation files

Follow-up to the Codex MVP. Format notes: docs/harnesses/codex.md.

- Subagents: find child rollouts by parent_thread_id (they are in the date tree, not beside the parent; thread_spawn_edges in state_5.sqlite also maps them). Link them to the parent's spawn_agent call / SubAgentActivity items; subagent steps and usage like Claude Code's (sumsSubagentUsage if the numbers are reliable). Ignore the child's replayed parent history before subagent_history_start_ordinal (mark inherited; never count its usage).
- Compaction: `compacted` lines become compaction events; responses after it are rebuilds for cache.ts. Count compaction calls' usage when a token_usage_record exists for them.
- .jsonl.zst: read with Node's zlib zstd (available since 22.15, see the note below); prefer the plain file when both exist. Callers (pipeline, browse job) read a file into one string for `parse(raw: string)`: decompress to a string there for now, within ove-m3y1's size limit; true streaming would change that interface and is its own decision.
- Continuation files `rollout-<time>-<thread>_<rollout-id>.jsonl`: one session.
- Needs synthetic fixtures for each; there are no local samples of compaction, zst or continuation files.


## Notes

**2026-11-20T18:25:26Z**

Resolved 2026-11-20: .jsonl.zst needs no dependency. Node >= 22.15 has zlib.zstdDecompressSync / createZstdDecompress (docs say Experimental; no runtime ExperimentalWarning in 22.19's lib/zlib.js). Stream-decompress large files rather than reading them whole (ccusage issue 1124). Details: docs/harnesses/codex.md.

**2026-11-20T19:29:38Z**

Split into two PRs: (1) subagents + compaction (this branch, feat/codex-subagents); (2) .jsonl.zst + continuation (revert) files. Continuation files per upstream codex-rs rollout_file_name.rs: rollout-<ts>-<thread>_<rollout-id>.jsonl, header history_base {thread_id: prefix rollout id, end_ordinal_exclusive, end_byte_offset} = an immutable prefix of the earlier rollout. Decisions for (1): subagent files found by header parent_thread_id across the sessions tree (BFS, grandchildren included); only lines from subagent_history_start_ordinal count; spawn step linked via SubAgentActivity(started).agent_thread_id (task name match, else latest unmatched spawn); linking code moved to src/harnesses/subagent-runs.ts unchanged; codex meta sumsSubagentUsage; compaction = 'compacted' line (ContextCompaction item only if no such lines), the bare usage record just before it gets purpose compaction.
