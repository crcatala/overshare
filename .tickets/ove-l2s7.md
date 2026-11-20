---
id: ove-l2s7
status: open
deps: [ove-m3y1]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 4
assignee: cc-vps
parent: ove-v5c6
tags: [harness, codex]
---
# Codex: legacy history mode (pre-paginated rollouts)

Only if someone has such files: older Codex CLIs (roughly <= 0.125, history_mode legacy or absent) write user_message / agent_message / agent_reasoning / exec_command_end / patch_apply_end / mcp_tool_call_end / web_search_end / context_compacted event_msg lines instead of item_completed. No local samples (one 2025 file with a header only). Build fixtures from openai/codex types and from parsers that handle both shapes (masonc15/codex-transcript-viewer). Files before ~Sept 2025 have no token usage at all.

