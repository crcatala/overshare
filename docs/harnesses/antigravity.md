# Google Antigravity session format (research notes)

Status: research, nothing implemented yet. Plan and tickets: `.tickets/` epic "Support Codex and Antigravity
sessions". Gathered 2026-11-20 from 4 local conversations (Antigravity 1.5.12–1.5.13, the ACP build that T3
Code runs), plus community reverse-engineering. **Google publishes no description of these files**; its docs
only name the `~/.gemini/antigravity/` folder. Everything below is observed, and the format changes between
versions and between products (app, IDE, `agy` CLI, ACP), so skip unknown types and keep a fixture per version.

## Where conversations live

Each product has its own data folder (the "app data dir"):

| Product | Data folder |
|---|---|
| Desktop app 2.x | `~/.gemini/antigravity/` |
| IDE | `~/.gemini/antigravity-ide/` |
| `agy` CLI | `~/.gemini/antigravity-cli/` |
| ACP server | `~/.gemini/antigravity-acp/` |
| ACP server run by T3 Code | `~/.local/share/t3/userdata/providers/antigravity/<hash>/antigravity-acp/` |

ccusage also checks `~/.gemini/antigravity-backup/` and `~/.config/antigravity/`, and honours
`ANTIGRAVITY_DATA_DIR`. Inside a data folder (as seen in the T3 one):

```
conversations/<uuid>.db                     SQLite, one per conversation (+ -wal / -shm while open)
brain/<uuid>/.system_generated/
  logs/transcript_full.jsonl                readable transcript, one line per step   <- parse this
  logs/transcript.jsonl                     same steps, long fields shortened (`truncated_fields`)
  logs/chunks/{transcript,transcript_full}/0000000N.jsonl   the same bytes split into chunks
  logs/media/step_<n>_media_<i>.png         images referenced by steps
  steps/<n>/output.txt                      full output of a tool result that was shortened
  messages/<uuid>.json, read.json           notices to the agent (background task finished, ...)
  tasks/task-<n>.log                        background task output
brain/<uuid>/scratch/                       files the agent made (not transcript)
annotations/<uuid>.pbtxt                    title:"Fix Flaky Login Test"
conversation_summaries.db                   index: title, workspace_uris, step_count, parent_conversation_id, ...
implicit/<uuid>.pb                          small background trajectories; not conversations
antigravity-oauth-token                     login token: add to `credentialFiles`, never read otherwise
```

- Conversation id = `<uuid>` (the same in `conversations/`, `brain/`, `annotations/` and the index).
- Conversations with no steps exist (T3 creates two while setting up, in `~/.tmp/t3-antigravity-setup-*`);
  `listFiles` should skip conversations without a transcript.
- Open the SQLite files read-only (`mode=ro`); the running agent holds them in WAL mode.
- Older builds stored `conversations/<uuid>.pb` (AES-encrypted protobuf). Out of scope.
- `agy` before about 1.0.12 (June 2026) wrote markdown files under `brain/` instead of the JSONL transcript.

## `transcript_full.jsonl`

Every line: `step_index`, `type`, `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `status` (`DONE`, `RUNNING`),
`created_at` (UTC). These keys are generic, so `detect` should require all of them plus a `type` from the known
set, and `sessionId` comes from the path (`brain/<id>/…`), not from the file. **The JSONL can skip steps**: a
step the `.db` has with status 6 (apparently cancelled) was missing from the transcript, so `step_index` has
gaps. Types seen locally (286 steps at first count):

| `type` | count | fields | maps to |
|---|---|---|---|
| `USER_INPUT` | 11 | `content` | user prompt (see unwrapping below) |
| `PLANNER_RESPONSE` | 92 | `model`, `input_tokens`, `cache_read_tokens`, `output_tokens`, `content`, `thinking`, `tool_calls[]` | one model response: text, thinking, tool calls, usage |
| `GENERIC` | 173 | `content`, `media[]` | a tool result |
| `SYSTEM_MESSAGE` | 9 | `content` | injected notice (reminders, background task results) |
| `ERROR_MESSAGE` | 1 | `error`, `content` | error event ("The stream was interrupted…") |

agent-sessions documented `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY` and `CHECKPOINT` (compaction) for
`agy` 1.0.12, and no token fields; 1.5.x ACP writes `GENERIC` for every tool result and adds usage. Accept both.

**Tool calls.** `tool_calls[]` holds `{name, args}`. Seen: `run_command` (`CommandLine`, `WaitMsBeforeAsync`,
`IsDaemon`, `toolSummary`), `read_file` (`Path`, `StartLine`, `EndLine`), `edit_file` (`Path`, `Target`,
`Replacement`), `write_file` (`Path`, `Content`, `Overwrite`), `search_web` (`query`), `manage_task` (`Action`,
`TaskId`: kills a background task), and MCP tools named `mcp_<server>_<tool>`. The JSONL has **no call ids**.
Results usually follow as the next N `GENERIC` steps, but not always: in one response with 3 calls, the third
result was the skipped status-6 step, so the next line was a `SYSTEM_MESSAGE` and counting by position would
pair wrongly. Pair by id from the `.db` instead: each model response lists its calls (id, name, args), and each
tool-result step carries its call's id (payload field 5 → 4 → 1). Where the `.db` is unavailable, pair by
position only when the count and the `step_index` sequence both line up; otherwise leave the result unpaired.

**Tool results.** `content` starts with `Created At:` / `Completed At:` lines. Long output is shortened to a
preview (the middle is cut) plus a pointer to `steps/<n>/output.txt`. Cutting text before redaction can leave a
partial secret that no pattern matches, so read the full `steps/<n>/output.txt` and redact that; if the file is
gone, drop the preview rather than share it. A background command returns a `RUNNING` result ("Tool is running
as a background task with task id …"); its end arrives later as a `messages/*.json` notice (sender
`<conversation>/task-<n>`, a title such as "Run tests finished") and in the transcript as a `SYSTEM_MESSAGE`. That is our `notification` event
with `wake`. Images: `media[]` entries `{mime_type, uri}` pointing at `logs/media/`; count them.

**Prompts.** `USER_INPUT.content` is wrapped:

```
<USER_REQUEST>
what the user typed
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: …
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting `Model Selection` from Gemini 4 Neon (High) to Gemini 4 Neon (Medium). …
</USER_SETTINGS_CHANGE>
```

Under T3 Code the **first** prompt also has T3's instructions inside `<USER_REQUEST>`
(`<t3_code_instructions>`, `<runtime_info>`), with the typed text in a nested `<user_request>`. The authored
text is the nested `<user_request>` when present, else `<USER_REQUEST>`. A settings change becomes a
`model_change` or `thinking_level` event.

**Usage.** On each `PLANNER_RESPONSE`, as JSON numbers (all 105 local responses; accept numeric strings too).
**`input_tokens` excludes cache reads** (6,501 input plus
35,192 read from cache), unlike Codex. `output_tokens` includes thinking; the JSONL has no split, the `.db` does
(thinking 98 + response 125 = output 223). No cache writes with Gemini; Claude models (Antigravity offers them)
would add them. No cost is recorded.

**Model.** `model` is the model plus its thinking level (`gemini-4-neon-high`); the `.db` has the base model
(`gemini-4-neon`) and a display name ("Gemini 4 Neon (High)"). Pricing should use the base model.

## What only the SQLite files have

- **Working directory, git, title.** The transcript has no cwd. The conversation's `trajectory_metadata_blob`
  has it (workspace URIs, git remote and branch, and the ACP system prompt); so does the cache
  `conversation_summaries.db` (`workspace_uris`, a JSON list of `file://` URIs; `title`; `step_count`;
  `last_modified_time`; `parent_conversation_id`; `nesting_depth`). Title also in `annotations/<uuid>.pbtxt`.
  Which to trust is below.
- **Tool-call ids, thinking vs response tokens, exact timestamps, skipped steps.** `conversations/<uuid>.db`
  tables `trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`, `parent_references`,
  `trajectory_metadata_blob`, `battle_mode_infos`. `steps` has one row per step, including any the transcript
  skipped, with protobuf blobs that are **plain, not encrypted** in 1.5.x. Fields that matter:
  - `steps.step_type`: 14 user input, 15 model response, 132 tool result, 101 system message, 17 error.
    `steps.status`: 3 done, 2 running, 6 seen on a step the transcript left out (matches
    xhluca/session-migrate's notes for 1.1.16 and 1.4.12 where they overlap).
  - `steps.metadata` field 9 = usage: 2 input, 3 output, 5 cache read, 4 cache write, 9 thinking output,
    10 response output, 1 model enum.
  - Model response payload (field 20): 3 thinking, 7 tool calls (1 id, 2 name, 3 args JSON).
  - Tool result payload: field 5 → 4 → 1 is the id of the call it answers.
  - `gen_metadata.data`: field 19 model (`gemini-4-neon`), 21 display name.

Node 22.13+ ships `node:sqlite`, so reading these needs no dependency; protobuf needs a small wire-format reader
(ccusage and session-migrate both do this without a schema). On Node 22.19, overshare's minimum, loading
`node:sqlite` prints `ExperimentalWarning: SQLite is an experimental feature` (v22.19 `lib/sqlite.js` calls
`emitExperimentalWarning('SQLite')`); 24.x does not. Load it lazily, only when an Antigravity data folder exists,
and keep that one warning off the user's terminal.

### Working directory: which source to trust

Read it from the conversation's own `.db`, `trajectory_metadata_blob` (row `main`), not from the index:

- Top-level field 7 (repeated string) = workspace URIs; field 1 (repeated message) = one workspace each, with
  1 URI, 3 git (1 `owner/repo`, 2 remote URL) and 4 branch. Only a top-level scan is needed.
- It matched `conversation_summaries.workspace_uris` for all 6 local conversations. The index is a cache: it
  already lists a conversation whose `.db` no longer exists, and others report that a crash can empty it, while
  the per-conversation `.db` is the record itself.
- A conversation can have **several workspaces**. Under T3 one had `…/t3/userdata/attachments` first and the repo
  second. `project.cwd` = the first workspace with git info, else the first that is not T3's attachments
  folder; `listFiles(cwd)` matches against all of them.
- Title: `annotations/<uuid>.pbtxt` (per conversation, plain text), else the index, else the first prompt.
- With no `.db` at all, the session is still listed and exportable by id or path, without a project, and is
  never picked by `--current` for a directory.

### Which conversation is "current"

The 1.5.13 binary sets `ANTIGRAVITY_CONVERSATION_ID` (and `ANTIGRAVITY_PROJECT_ID`) for plugin sidecars and its
`agentapi` command shims: its embedded docs say a sidecar's conversation "defaults to …
(`ANTIGRAVITY_CONVERSATION_ID`)", and its JS client reads `process.env.ANTIGRAVITY_CONVERSATION_ID`. Whether
commands from the agent's `run_command` also get it is **not verified** (no local command printed its
environment). `currentSession` should read it when present and otherwise fall back to the newest session for
the cwd, as for pi.

## Redaction and privacy

- Add `antigravity-oauth-token` (in every data folder found) to the credential files read for known values.
  It is JSON (`token` object, `auth_method`, `id_token_email`), so the existing JSON credential reader works.
- Never copy the ACP system prompt from `trajectory_metadata_blob`, nor the T3 instructions in the first prompt
  (they are not what the user typed; they are fine to drop entirely).
- `SYSTEM_MESSAGE` reminders ("Reminder: work efficiently…") are injected by the harness: an event at most.

## Local sample coverage

4 conversations (3, 16, 101 and 166 steps; Nov 19–20 2026), all from T3 Code, all Gemini 4 Neon, with edits,
web search, an MCP tool, background tasks (one killed with `manage_task`), images, one stream error and one
step the transcript skipped. Not covered: plain `agy`, the desktop app or IDE,
Claude models, compaction (`CHECKPOINT`), subagents (`parent_conversation_id`; the "swarm" plugin is enabled in
the T3 config), legacy `.pb` files. Fixtures must be synthetic.

## Sources

- ccusage `rust/adapters/antigravity/` (data folders, read-only SQLite, usage from `gen_metadata`/`steps`).
- xhluca/session-migrate `docs/antigravity-format.md` (clean-room `.db` schema and step fields).
- jazzyalex/agent-sessions `docs/superpowers/specs/2026-06-26-antigravity-cli-jsonl-migration-design.md`
  (`transcript.jsonl` as of `agy` 1.0.12; the move from markdown to JSONL).
- Community exporters that talk to the running language server instead of reading files (agy-reader,
  antigravity-history, antigravity-conversation-export): not needed for overshare, which reads files only.
