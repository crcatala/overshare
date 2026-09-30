# Claude Code subagent sessions

Ten real Claude Code sessions (2.1.285, and 2.1.286 for the last three) from a throwaway sandbox repo (a few tiny JS files), trimmed and
scrubbed so they can be committed. The directory mirrors `~/.claude/projects`:

```
-home-fixture-user-work-usage-sandbox/
  <session-id>.jsonl                          main transcript (ends with Claude Code's own `cost-state` line)
  <session-id>/subagents/agent-<id>.jsonl     one file per subagent, every line `isSidechain: true`
  <session-id>/subagents/agent-<id>.meta.json agentType, description, toolUseId (the launching tool_use), requestShape
```

| session | what it covers |
| --- | --- |
| `2b450029` | two background subagents, `-p` mode: `async_launched` results and two `<task-notification>` user lines |
| `9150e1c1` | one background subagent, interactive. **Not reconciled**, see below |
| `491c3f9b` | one foreground subagent; the Agent `tool_result` carries `usage` / `totalTokens` (last call only) |
| `9a69feab` | Sonnet 5.5 main with a custom `reviewer` agent on Haiku 4.5 (9 calls, 18 tool uses): mixed models |
| `bf3c7500` | three parallel foreground subagents (one assistant message, three launches) |
| `2a10ef7b` / `edf2048e` | the same prompt on Opus 5.5 in fast and in standard mode (`usage.speed`) |
| `113ee2dc` | a foreground agent resumed with `SendMessage`: the agent's file keeps growing (one file, one agent id), the second hand-back arrives in the `SendMessage` result |
| `1c1bb33a` | nested: a subagent launches a subagent. Both files sit side by side in `subagents/`; the inner one has `parentAgentId` and `spawnDepth: 2`, and its `toolUseId` names a launch inside the parent's file, not in main |
| `1ccce9c5` | a forked skill (`context: fork`) run with `-p`: main holds no model call and no `Agent` launch, the skill's spend exists only in the subagent file, whose meta has no `toolUseId` |

In every session the main transcript (where it has model calls at all) wrote 1h cache entries and the subagents wrote 5m ones.

Not a fixture: `/btw` side questions write no sidechain lines and no subagent files (checked on 2.1.286); their spend shows up only in `cost-state`, which is one likely source of the `9150e1c1` residual below.

## The invariant

Summing `usage` over unique `message.id`s across the main file and every subagent file reproduces
`cost-state.modelUsage` exactly (input, output, cache read, cache write, per model) in nine of the ten
sessions, with no message id shared between main and subagent files. `tests/subagent-fixtures.ts` computes both
sides straight from the raw JSON; `tests/claude-subagent-fixtures.vitest.ts` asserts it.

`9150e1c1` is the exception: `cost-state` holds more than the files show (+1,648 input, +890 output, +71,616
cache read, +372 cache write). The test pins that residual and checks the files never exceed `cost-state`.
Its cause is not established; it is the interactive run, so calls Claude Code makes but does not persist are the
likely source.

## What was changed

`scripts/sanitize-claude-fixtures.mjs <project-dir> <out-dir>` produced these files from the originals:

- dropped the large injected-context attachments (prompt snapshot, skill / agent / MCP listings, instructions,
  session context, credential org, ...) and file-history snapshots; kept `date`, `model`, `total_tokens_reminder`
  and `budget_usd`; re-linked `parentUuid` over the dropped lines;
- shortened thinking signatures;
- replaced the home directory, username, working directory and temp task paths with `/home/fixture-user/...` and
  `/tmp/claude-fixture/...`.

Usage objects, `cost-state`, ids, timestamps, `origin`, notifications and `meta.json` are as recorded.
The script refuses to write a file that still contains the home directory, username, an email or account ids.
