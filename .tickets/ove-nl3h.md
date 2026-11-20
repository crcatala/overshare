---
id: ove-nl3h
status: open
deps: [ove-m3y1, ove-f6hn]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-v5c6
tags: [harness, antigravity]
---
# Antigravity harness: transcript_full.jsonl plus the summary index

First usable Antigravity support. Format notes: docs/harnesses/antigravity.md.

## Scope
- src/harnesses/antigravity/ descriptor + meta.ts entry. Roots: every data folder that exists among ~/.gemini/antigravity{,-cli,-ide,-acp}, ~/.local/share/t3/userdata/providers/antigravity/*/antigravity-acp, plus an env override (match ccusage's ANTIGRAVITY_DATA_DIR). This is the first harness with several roots: the descriptor/resolve may need a list.
- Session file: brain/<id>/.system_generated/logs/transcript_full.jsonl (fall back to transcript.jsonl). Skip conversations without one.
- cwd and title from conversation_summaries.db (node:sqlite, read-only) or annotations/<id>.pbtxt, through the extra-files hook added for Codex, so parse stays pure. Without a cwd, listFiles(cwd) cannot match; decide what happens when the index is missing (fall back to the trajectory_metadata_blob, or leave the session out of --current).
- parse: USER_INPUT unwrapping (nested <user_request> under T3, else <USER_REQUEST>; drop ADDITIONAL_METADATA; USER_SETTINGS_CHANGE becomes a model/thinking-level event); PLANNER_RESPONSE text, thinking text, tool calls paired with the next N GENERIC results; RUNNING results and background-task SYSTEM_MESSAGEs as notifications; ERROR_MESSAGE as an error event; media counted; also accept agy 1.0.x types (RUN_COMMAND, VIEW_FILE, LIST_DIRECTORY, CHECKPOINT as compaction).
- Usage from PLANNER_RESPONSE (strings; input excludes cache reads; reasoning unknown until the .db ticket). Model name: keep as written, price by base model.
- credentialFiles: antigravity-oauth-token in each data folder (check the known-values reader accepts a non-JSON token file).
- currentSession: find out whether Antigravity/ACP exposes a conversation id to commands it runs; if not, newest session for the cwd.
- Synthetic fixtures: T3-wrapped first prompt, parallel tool calls, a truncated result, a background task, an image, a stream error, a settings change.

## Acceptance
- [ ] list / browse / report / export / publish work on the local T3 conversations.
- [ ] Prompts mode shows only the typed text (no T3 instructions).
- [ ] Token totals match the sum of PLANNER_RESPONSE usage.


## Notes

**2026-11-20T18:25:26Z**

Resolved 2026-11-20 (docs/harnesses/antigravity.md):
- cwd: read the conversation .db's trajectory_metadata_blob (top-level field 7 URIs; field 1 workspaces with git and branch), not conversation_summaries.db. Matched the index on 6/6; the index is a cache and already holds a stale entry. Several workspaces are possible (T3 adds its attachments folder first): cwd = first workspace with git info, else first non-attachments one; listFiles(cwd) matches any. So this MVP already needs node:sqlite plus a top-level protobuf scan, shared later with ove-ntsi. Title from annotations/<id>.pbtxt.
- currentSession: read ANTIGRAVITY_CONVERSATION_ID when set (the 1.5.13 binary sets it for plugin sidecars and agentapi shims; not verified for run_command shells), else newest session for the cwd. A one-line check in an Antigravity thread (printenv | grep ANTIGRAVITY) settles it.
- antigravity-oauth-token is JSON (token, auth_method, id_token_email): the existing JSON credential reader handles it.
