---
id: ove-nl3h
status: closed
deps: [ove-m3y1, ove-f6hn]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-v5c6
tags: [harness, antigravity]
---
# Antigravity harness: transcript_full.jsonl plus the conversation .db

First usable Antigravity support. Format notes: docs/harnesses/antigravity.md (authoritative where this ticket is terser).

## Scope
- src/harnesses/antigravity/ descriptor + meta.ts entry. Roots: every data folder that exists among ~/.gemini/antigravity{,-cli,-ide,-acp}, ~/.local/share/t3/userdata/providers/antigravity/*/antigravity-acp, plus an env override (match ccusage's ANTIGRAVITY_DATA_DIR). First harness with several roots: `sessionsRoot` / `SessionRoots` hold one string per harness today, so this PR decides between a list there or one parent root plus discovery in `listFiles`.
- Session file: brain/<id>/.system_generated/logs/transcript_full.jsonl (fall back to transcript.jsonl). Skip conversations without one.
- `sessionId`: the `<id>` folder name from the path (the lines carry no id). `detect`: a line with all of `step_index` (number), `type` (from the known set, incl. agy 1.0.x types), `source` (USER_EXPLICIT / MODEL / SYSTEM) and `status`, so `publish <path>` works and other JSONL is not mistaken for it.
- Read conversations/<id>.db read-only through the extra-files hook added for Codex (parse stays pure), with node:sqlite and a small protobuf wire reader:
  - cwd, git remote and branch from trajectory_metadata_blob (top-level field 7 URIs; field 1 workspaces). Several workspaces are possible: cwd = first with git info, else first that is not T3's attachments folder; listFiles(cwd) matches any of them. conversation_summaries.db is a cache (already holds a stale entry): use it only as a fallback.
  - tool-call ids: pair each tool result with its call by id (result payload field 5 -> 4 -> 1; calls in the model response). The JSONL can skip steps (a status-6 step was missing), so never pair purely by position: without the .db, pair by position only when the count and step_index sequence line up, else leave results unpaired.
  - No .db at all: the session is still listed and exportable by id or path, without a project, and never picked by --current for a directory.
- node:sqlite prints an ExperimentalWarning on Node 22.19: load it lazily (only when an Antigravity data folder exists) and keep that warning off the terminal. Test it on the min-node CI job.
- Title from annotations/<id>.pbtxt, else the index, else the first prompt.
- parse: USER_INPUT unwrapping (nested <user_request> under T3, else <USER_REQUEST>; drop ADDITIONAL_METADATA; USER_SETTINGS_CHANGE becomes a model/thinking-level event); PLANNER_RESPONSE text, thinking text, tool calls (incl. manage_task and mcp_<server>_<tool>); RUNNING results and background-task SYSTEM_MESSAGEs as notifications; ERROR_MESSAGE as an error event; media counted; also accept agy 1.0.x types (RUN_COMMAND, VIEW_FILE, LIST_DIRECTORY, CHECKPOINT as compaction).
- Shortened tool output: read the full steps/<n>/output.txt and hand that to redaction (never redact a preview whose middle was cut: ass-7x3c); if the file is gone, drop the preview.
- Usage from PLANNER_RESPONSE (JSON numbers; accept numeric strings; input excludes cache reads). Thinking vs response split is ove-ntsi. Model name: keep as written, price by base model.
- credentialFiles: antigravity-oauth-token in each data folder (JSON; the existing reader handles it).
- currentSession: ANTIGRAVITY_CONVERSATION_ID when set (unverified for run_command shells), else newest session for the cwd.
- Synthetic fixtures: T3-wrapped first prompt, parallel tool calls, a skipped step between results, a truncated result with a secret across the cut, a background task killed with manage_task, an MCP tool, an image, a stream error, a settings change, a conversation without a .db.

## Acceptance
- [ ] list / browse / report / export / publish work on the local T3 conversations; `harness:antigravity` and `--current` work for a workspace.
- [ ] Prompts mode shows only the typed text (no T3 instructions).
- [ ] Every tool result in the local conversations is attached to the call the .db says it answers (checked with a script, not committed).
- [ ] A secret that straddles a truncation cut is redacted in full (fixture test).
- [ ] Token totals match the sum of PLANNER_RESPONSE usage.
- [ ] No ExperimentalWarning on stderr under Node 22.19.

## Notes

**2026-11-20T18:25:26Z**

Resolved 2026-11-20 (docs/harnesses/antigravity.md):
- cwd: read the conversation .db's trajectory_metadata_blob (top-level field 7 URIs; field 1 workspaces with git and branch), not conversation_summaries.db. Matched the index on 6/6; the index is a cache and already holds a stale entry. Several workspaces are possible (T3 adds its attachments folder first): cwd = first workspace with git info, else first non-attachments one; listFiles(cwd) matches any. So this MVP already needs node:sqlite plus a top-level protobuf scan, shared later with ove-ntsi. Title from annotations/<id>.pbtxt.
- currentSession: read ANTIGRAVITY_CONVERSATION_ID when set (the 1.5.13 binary sets it for plugin sidecars and agentapi shims; not verified for run_command shells), else newest session for the cwd. A one-line check in an Antigravity thread (printenv | grep ANTIGRAVITY) settles it.
- antigravity-oauth-token is JSON (token, auth_method, id_token_email): the existing JSON credential reader handles it.

**2026-11-20T19:54:30Z**

Decisions (PR): (1) several data folders: one root per harness kept; Antigravity's root is one data folder (OVERSHARE_ANTIGRAVITY_DIR, else ANTIGRAVITY_DATA_DIR) or, by default, the home folder, under which listFiles discovers every known data folder (~/.gemini/antigravity{,-ide,-cli,-acp,-backup}, ~/.config/antigravity, ~/.local/share/t3/userdata/providers/antigravity/*/antigravity-acp). No SessionRoots type change. (2) protobuf reader lives in src/harnesses/antigravity/protobuf.ts (schema-less, defensive). (3) node:sqlite: loaded lazily via createRequire only when a .db is read; process.emitWarning filtered for that one ExperimentalWarning during the load; verified no stderr under Node 22.19 with the built CLI. DB opened via file URL mode=ro, plus immutable=1 when -wal is empty. (4) Sidecar carries id, title (annotation), workspaces, call ids, result->call map, full outputs of shortened results (from this conversation's own steps/<n>/output.txt only; missing file -> preview dropped). (5) Without a DB: pair by position only while step indexes are consecutive; else a standalone 'tool' step. (6) SYSTEM_MESSAGE: '[Message] ... content=' -> notification; reminders dropped. Settings change 'from None' (first selection) not shown. (7) Local check: 4/4 conversations, every result attached to the call the .db names, token totals equal the transcript sums.
