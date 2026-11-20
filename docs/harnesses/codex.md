# OpenAI Codex session format (research notes)

Status: research, nothing implemented yet. Plan and tickets: `.tickets/` epic "Support Codex and Antigravity
sessions". Gathered 2026-11-20 from 62 local rollouts (Codex CLI 0.163–0.169, plus one 0.58 file), the
`openai/codex` source, and other parsers. OpenAI calls the rollout file an internal resume log, not a public
format, so expect drift: skip unknown line types instead of failing, and add a fixture for every new shape.

## Where sessions live

```
$CODEX_HOME (default ~/.codex)/
  sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl   one file per thread (subagents too)
  archived_sessions/rollout-*.jsonl                              flat, after `codex archive`
  session_index.jsonl                                            {id, thread_name, updated_at}: user renames
  state_5.sqlite                                                 `threads` table: cwd, title, git, model, source, ...
  thread_history_1.sqlite                                        a projection of the rollouts (derived, ignore)
  auth.json                                                      credentials (already in `credentialFiles` redaction)
```

- Folders are by **date, not by working directory**. Listing the sessions of one cwd means reading each file's
  first line (`session_meta.payload.cwd`), or the `threads` table in `state_5.sqlite` as a fast path (`node:sqlite` warns on Node 22.19; see
  antigravity.md). The first line is large (~20–25 KB: it carries the base instructions), so read it, don't parse the file.
- The session id is the UUID at the end of the file name (= `session_meta.payload.id`).
- `--current`: Codex sets `CODEX_THREAD_ID` in the environment of every command it runs
  (`codex-rs/core/src/exec_env.rs`).
- Reported by other parsers, not seen locally: idle rollouts are recompressed to `rollout-*.jsonl.zst` after
  about 7 days, and a thread can continue in `rollout-<time>-<thread>_<rollout-id>.jsonl`. Node can read the
  `.zst` files without a dependency: `zlib.zstdDecompressSync` / `createZstdDecompress` exist since 22.15.0
  (overshare needs ≥ 22.19). The docs mark them Experimental, but `lib/zlib.js` in 22.19 emits no
  `ExperimentalWarning` for them.
- `codex exec --json` prints a different JSONL on stdout (`item.completed`, `turn.completed`). It is not a
  rollout; `detect` must not accept it.

## Line envelope

```json
{"timestamp":"2026-11-13T18:43:37.909Z","ordinal":0,"type":"<kind>","payload":{...}}
```

`ordinal` is newer (absent in 2025 files). Line kinds seen locally (all 62 files):

| `type` | count | notes |
|---|---|---|
| `event_msg` | 4799 | `item_completed` 3177, `token_count` 1251, `thread_settings_applied` 128, `task_started` 122, `task_complete` 119, `turn_aborted` 2 |
| `response_item` | 4100 | `custom_tool_call` / `_output` 1138 each, `reasoning` 912, `message` 844, `additional_tools` 60, `function_call` / `_output` 3 / 2, `agent_message` 3 |
| `token_usage_record` | 1249 | one per model response |
| `turn_context` | 122 | per turn: `model`, `effort`, `cwd`, `turn_id` |
| `world_state` | 91 | harness state: full snapshot, then merge patches |
| `session_meta` | 63 | header (a subagent file has two) |
| `inter_agent_communication_metadata` | 3 | precedes a subagent message |

Also in the source but not seen locally: `compacted` (a compaction checkpoint with `message` and
`replacement_history`), `retained_context`, `dynamic_tools_updated`, `security_risk_score`, `realtime_item`.

## Two copies of every turn

`response_item` is what the model saw. `event_msg` / `item_completed` is the display stream. Which `event_msg`
kinds get written depends on `session_meta.payload.history_mode` (`codex-rs/rollout/src/policy.rs`):

- `paginated` (all current local files): `item_completed` with `item.type` of `UserMessage`, `AgentMessage`,
  `CommandExecution`, `Reasoning`, `Extension` (web search), `SubAgentActivity`; upstream also has
  `FileChange`, `Plan` and others.
- `legacy` (older CLIs, roughly ≤ 0.125): `user_message`, `agent_message`, `agent_reasoning`,
  `exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `web_search_end`, `context_compacted`. No local
  samples; needs fixtures built from the upstream types.

What each part of a normalized session should come from:

| Normalized | Source | Nuance |
|---|---|---|
| User prompt | `item_completed` `UserMessage` (legacy: `user_message`) | This is what the user typed, so prompts can be marked `authored`. `response_item` user messages also carry injected AGENTS.md, `<environment_context>`, `<skill>` expansions and `<turn_aborted>`; drop those. |
| Skill / command | A `$skill-name` prompt, followed by a `<skill>` user `response_item` | Maps to a `skill` event, invoked by the user. |
| Assistant text | `response_item` `message`, role `assistant` | `phase: commentary` (progress) vs `phase: final_answer`. Fits brief and minimal modes. |
| Thinking | `response_item` `reasoning` | Usually only `encrypted_content`, with an empty `summary`. Count blocks; there is no text to show. |
| Tool calls | see below | |
| Model, effort | `turn_context` | A switch also injects a `<model_switch>` developer message. |
| Errors | `task_complete.error` (for example an API 400) | Event step. |
| Interrupt | `event_msg` `turn_aborted` (`reason: interrupted`) | `interrupted` event. |
| Title | `session_index.jsonl` (renames), `state_5.sqlite` `threads.title`, else the first prompt | |
| Project | `session_meta.cwd`, `git.{branch, commit_hash, repository_url}` | `~/.codex/worktrees/<id>/<repo>` is already understood by `src/sessions/repo.ts`. |

## Tools ("code mode")

In every current local session the model makes **one** `custom_tool_call` named `exec`, whose `input` is
JavaScript that calls the real tools:

```js
const results = await Promise.allSettled([
  tools.exec_command({cmd: "cat README.md", max_output_tokens: 6000}),
  tools.exec_command({cmd: "gh pr diff 42"}),
]);
```

Seen inside: `tools.exec_command` 1692, `tools.write_stdin` 53, `tools.web__run` 9. One `exec` call fans out to
several `item_completed` `CommandExecution` items, each with `command`, `cwd`, `exit_code`, `duration`,
`aggregated_output` and `parsed_cmd[]`. `parsed_cmd[].type` is `read` (with `path`), `search`, `list_files` or
`unknown`, which gives our `ToolAction` and file lists. Output is stored twice (each item's
`aggregated_output`, and all of them together in the `custom_tool_call_output`); keep one.

The normalized steps should be the `CommandExecution` items (one tool step each, grouped under the `exec`
call), not the JavaScript. Non-code-mode sessions use `function_call` (`shell`, `shell_command`) and
`custom_tool_call` `apply_patch` for edits (no local sample with edits). Collaboration tools are
`function_call` with `namespace: "collaboration"` (`spawn_agent`, `send_message`).

## Token usage

- `token_usage_record` (one per `response_id`, with `turn_id`) is authoritative. `event_msg` `token_count`
  repeats it as `last_token_usage` plus a running `total_token_usage`. Locally, the records sum exactly to the
  final total. Skip `token_count` with `info: null` (a rate-limit refresh).
- **`input_tokens` includes `cached_input_tokens`.** Normalized `input` = `input_tokens − cached_input_tokens`,
  `cacheRead` = `cached_input_tokens`. `reasoning_output_tokens` is part of `output_tokens` (our convention).
  `cache_write_input_tokens` is always 0. `total_tokens = input_tokens + output_tokens`.
- No cost is recorded, so cost is an estimate (`costSource: "estimated"`) and needs OpenAI prices.
- Before `token_usage_record` existed (about CLI 0.154), only `token_count` deltas exist, and compaction calls
  may be missing from them. Very old (2025) files have no usage at all.

## Subagents

- A spawned agent writes its own rollout (in the date tree, not beside the parent). Its first `session_meta`
  has its own `id`, plus `parent_thread_id`, `forked_from_id`, `agent_path` (`/root/explorer`),
  `agent_nickname`, `thread_source: "subagent"` and `source.subagent.thread_spawn`. A **second**
  `session_meta` follows with the parent's id.
- The child then replays the parent's history up to `subagent_history_start_ordinal` (47 in the sample):
  inherited, not the child's own work. In 0.167 the replay carried no token records; older builds replayed
  `token_count` too, which made ccusage over-count about 91× (ccusage issue 950). Count only the child's lines
  from that ordinal on.
- In the parent: `function_call` `spawn_agent` (its `message` argument is **encrypted**), `SubAgentActivity`
  items (`kind: started` / `completed`, `agent_thread_id`), and `response_item` `agent_message` from
  `/root/<name>` with the result. `state_5.sqlite` `thread_spawn_edges` maps parent to child.
- `listFiles` must leave subagent files out of the top-level list (check `thread_source` / `source.subagent`
  on the first line).

## Redaction and privacy

- **Drop before redaction:** `reasoning.encrypted_content`, the encrypted `spawn_agent` message and any other
  `gAAAA…` blob. **The final re-scan is no backstop for these:** it runs only `findSecretPatterns` (no entropy
  check), which matched 1 of 939 local `encrypted_content` values. A blob copied by mistake would almost always be
  published (and the odd one would block a publish for no visible reason), so the drop is mandatory and tests
  must assert that no `gAAAA…` reaches the share payload.
- **Never copy:** `session_meta.base_instructions` / `instructions`, `creator_user_id`, `creator_account_id`,
  `world_state` (it holds the full AGENTS.md, skills and plugin lists), `additional_tools`, developer messages.
  `turn_context` and `thread_settings_applied` carry sandbox and permission profiles: only keep model and effort.
- Images arrive as `input_image` data URLs inside `response_item` content; count them, as other harnesses do.

## Local sample coverage

Of the 62 local files, 59 are unattended `codex exec` PR-review runs (launched from T3 Code), one is a subagent
spawned by one of them, one is an interactive VS Code session (with an error turn, a model switch and an
interrupt), and one is a 2025 CLI file with only a header and the environment message. Not covered: file edits, compaction, `.jsonl.zst`,
continuation files, legacy history mode, MCP tools. Test fixtures must be synthetic (no real transcripts in the
repo); build them from the shapes above and from upstream types.

## Other parsers worth reading

- `openai/codex`: `codex-rs/history/src/lib.rs` (`RolloutItem`), `codex-rs/rollout/src/policy.rs` (what is
  persisted per history mode), `codex-rs/core/src/exec_env.rs` (`CODEX_THREAD_ID`).
- ccusage (`ccusage codex`): usage deltas, parent replay, `.jsonl.zst`, model fallback for old files.
- tokscale (`junhoyeo/tokscale`, `crates/tokscale-core/src/sessions/codex.rs`): cumulative-to-delta edge cases.
- skillsynchq/txcript `docs/formats/codex.md`, masonc15/codex-transcript-viewer (handles both history modes).
  These three were cited by research and not reviewed line by line.
