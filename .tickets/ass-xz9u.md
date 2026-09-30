---
id: ass-xz9u
status: closed
deps: []
links: [ass-75mx, ass-z5og, ass-5r99, ass-zc54, ass-rc52, ass-cjrn]
created: 2026-09-30T14:55:28Z
type: bug
priority: 1
assignee: cc-vps
external-ref: ass-rc52
tags: [claude-code, subagents, privacy, adapters]
---
# Claude background-subagent task-notifications become user turns and leak into prompts mode

## Problem (found while investigating ass-rc52, verified on a synthetic session)

Claude Code 2.1.285 runs subagents in the background by default. When one finishes, the main transcript gets a `type:user` line with `origin: {kind: "task-notification", producer: "session-task"}` (plus `queue-operation` lines) whose text is `<task-notification>...<result>FULL SUBAGENT ANSWER</result><usage>...</usage></task-notification>`.

`parseClaudeCode` (src/adapters/claude-code.ts) does not look at `origin`, so each notification starts a NEW TURN whose user prompt is that raw XML. Reproduced on synthetic session 2b450029 (~/.claude/projects/-home-mog-workspace-usage-sandbox/): turns 1 and 2 are notifications. Consequences:
1. The viewer shows raw `<task-notification>` XML as if the user typed it, and turn counts and prompts are wrong.
2. PRIVACY: `projectSession(full, "prompts")` keeps `turn.user.text`, so the subagent's result text is published in prompts mode, which promises "only authored user prompts and numeric counts". Verified: prompts-mode turns 1 and 2 contain the subagent's answer. Real sessions can carry file contents or secrets in subagent results. Same fail-closed spirit as ass-wqdt (unverified pi prompt expansions).

Existing tests and fixtures only model the older attachment form (`queued_command`, commandMode task-notification), which is already dropped; the user-message form is new.

## Fix
- Classify user lines by `origin.kind` (task-notification and any other non-human origin) so they never create a turn or prompt. Fail closed: an unknown `origin.kind` that is not clearly human input must not be treated as an authored prompt in prompts mode. Decide the allowlist (human = origin absent, or a known human kind) and verify it against the local corpus.
- Attach the notification's `<result>` (bounded, see ass-rc52 decision B) to the launching SubagentStep matched by `<tool-use-id>`, set `async: true`, and never display the XML.
- Do not use the notification's `<usage><subagent_tokens>`: it is a partial figure (14,150 vs 26,432 actual). Numbers come from the adapter ticket that reads the subagent files.
- Shares already published in prompts mode from affected sessions still contain the text. Mention it in the PR; a CLI warning on old shares is out of scope unless cheap.

## Acceptance
- Test (inline builder, no dependency on the fixtures ticket): a session with an async Agent launch followed by two notification user lines yields no extra turns; the results appear on the launching SubagentStep in full mode only; prompts-mode output contains none of the notification text (assert on the result string); brief and minimal drop `result` as they do today.
- Confirm the new test fails without the fix.
- Audit the local corpus: count user lines with `origin` set, per kind; confirm none are human prompts that would now vanish. Report in the PR.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-09-30T15:01:31Z**

Fix implemented on fix/task-notification-turns: user lines are classified by origin (absent or kind=human is authored; any other kind fails closed and never starts a turn). Task-notification results attach to the launching SubagentStep by tool-use-id (bounded to 4000 chars, async=true, XML never shown, notification usage ignored). Corpus audit: origin kinds seen = human, task-notification only.

**2026-09-30T15:02:20Z**

Shipped in PR (fix/task-notification-turns). Validation: 9 new tests (8 fail without the fix); corpus 97 Claude sessions, origin kinds human + task-notification only, 0 human prompts affected; synthetic session 2b450029 goes from 3 turns (prompts mode leaked the subagent answer) to 1 turn. Follow-ups: background Bash task-notifications (5 in corpus) are dropped, not attached to their Bash step; already-published prompts-mode shares from affected sessions still contain the text.

**2026-09-30T15:24:49Z**

Follow-up in the same PR: dropped old-format handling (schema bumped to agentshare/2, 'session-total' cost source and the toolGroup activity recompute removed, notifications recognised by origin only).
