---
id: ove-f0o0
status: open
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
- .jsonl.zst: read (zlib zstd in Node, check availability on 22.19); prefer the plain file when both exist.
- Continuation files `rollout-<time>-<thread>_<rollout-id>.jsonl`: one session.
- Needs synthetic fixtures for each; there are no local samples of compaction, zst or continuation files.


## Notes

**2026-11-20T18:25:26Z**

Resolved 2026-11-20: .jsonl.zst needs no dependency. Node >= 22.15 has zlib.zstdDecompressSync / createZstdDecompress (docs say Experimental; no runtime ExperimentalWarning in 22.19's lib/zlib.js). Stream-decompress large files rather than reading them whole (ccusage issue 1124). Details: docs/harnesses/codex.md.
