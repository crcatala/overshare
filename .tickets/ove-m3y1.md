---
id: ove-m3y1
status: open
deps: [ove-f6hn]
links: []
created: 2026-11-20T18:20:21Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-v5c6
tags: [harness, codex]
---
# Codex harness: current rollouts (paginated history mode)

First usable Codex support. Format notes: docs/harnesses/codex.md.

## Scope
- src/harnesses/codex/ descriptor + meta.ts entry. Root: $OVERSHARE_CODEX_SESSIONS, else $CODEX_HOME/sessions, else ~/.codex/sessions (+ archived_sessions/).
- listFiles: walk YYYY/MM/DD; for a cwd, read only the first line's session_meta.cwd (it is ~20 KB; do not parse the file). Leave subagent rollouts out (thread_source "subagent" / source.subagent). Consider state_5.sqlite `threads` as a fast path only if walking is too slow (node:sqlite warns on Node 22.19; see ove-nl3h).
- sessionId from the file name; detect on a session_meta line with payload.id + cli_version/originator (and never on `codex exec --json` output); currentSession from CODEX_THREAD_ID; credentialFiles: auth.json (already in known-values; move it to the descriptor).
- parse (paginated history mode):
  - prompts from item_completed UserMessage, marked authored; drop injected AGENTS.md / environment_context / <skill> / <turn_aborted> user response_items; $skill prompts become skill events.
  - assistant text from response_item message (phase commentary / final_answer).
  - code mode: each `exec` custom_tool_call becomes the CommandExecution items it produced (action from parsed_cmd: read/search/list_files, else exec; exit_code != 0 is an error); output kept once. function_call / custom_tool_call (apply_patch, shell) handled generically.
  - thinking: count encrypted reasoning blocks; never copy encrypted_content.
  - usage from token_usage_record (input = input_tokens - cached_input_tokens, cacheRead = cached, reasoning within output); fall back to token_count deltas when there are no records.
  - model/effort from turn_context, model_change events, task_complete.error and turn_aborted events.
  - project: cwd, git branch.
- summarize for browse; title from session_index.jsonl or the first prompt.
- Interface: listFiles that reads headers instead of folder names; whatever "extra files beside the transcript" hook is needed (session_index title now, subagents next) designed so Antigravity can reuse it. The browse index cache (src/sessions/index.ts) keys on the transcript file: when the hook lands, make a change to those extra files (a rename in session_index.jsonl) refresh the cached title.
- Size: other parsers report rollouts of many GB, and parse takes the whole file as one string. Set a size limit with a visible error (list/browse show the session as too large instead of dropping it silently); streaming is a later change.
- Drop list for redaction: base_instructions, creator ids, world_state, developer messages, additional_tools, encrypted blobs. The final re-scan does not catch encrypted blobs (patterns matched 1 of 939 local ones), so a test asserts that no `gAAAA…` value appears anywhere in the share payload.
- Synthetic fixtures covering: an oversized file, code-mode fan-out, parallel commands, an error turn, an interrupt, a model switch, a $skill prompt, an image, a session with no token_usage_record.
- README and docs/configuration.md: Codex listed, env var documented.

## Acceptance
- [ ] `overshare list`, `browse`, `report`, `export`, `publish --current` work on local rollouts; `--current` finds the running thread inside Codex.
- [ ] Token totals for a session equal the last total_token_usage in its file (checked on the local corpus with a script, not committed).
- [ ] All four share modes produce sensible output; prompts mode works (authored prompts).
- [ ] No encrypted blob appears in any share built from the local rollouts (script check), and the re-scan result on them is clean.
- [ ] typecheck, tests, fixtures for existing harnesses unchanged.

