---
name: share-session
description: Share the current Claude Code session as a redacted, unlisted link (secret GitHub gist + agent-share viewer). Use when the user asks to share, publish, or post this session/transcript, optionally with a mode (full, brief, minimal, prompts). `prompts` refuses unverified pi
sessions rather than publishing expanded template instructions as user text.
---

# Share this session

Publishes the current session with the `agent-share` CLI. Redaction always runs before
anything leaves the machine; the CLI refuses to publish if its final re-scan finds a
leftover secret.

Modes (default `brief`):
- `full` — everything after redaction (tool inputs/outputs truncated to 20k chars each)
- `brief` — prompts + replies; tool calls grouped (e.g. `Bash ×5 · Edit ×3`), no tool output
- `minimal` — prompts, the final reply per turn, and counts

## Steps

1. Pick the mode from the user's request (default `brief`).
2. Preview what would be shared (writes nothing):

   ```bash
   agent-share report --current --harness claude-code --mode <mode>
   ```

   `--current` resolves this session via `$CLAUDE_CODE_SESSION_ID`.
   Exit code: `0` clean, `2` needs review (secrets were redacted, or suspicious values remain), `3` blocked.

3. Act on the result:
   - **Clean (exit 0):** publish directly:
     ```bash
     agent-share publish --current --harness claude-code --mode <mode> --yes
     ```
   - **Needs review (exit 2):** show the user the `Findings` section verbatim (rules and
     locations only; it never contains secret values or the text around them) and ask whether to publish. Only after they explicitly
     agree, run the publish command with `--yes --allow-findings`. Never add
     `--allow-findings` on your own.
   - **Suspicious values (exit 2, `Status: NEEDS CONFIRMATION`):** the report has a `Suspicious`
     section. These values may be secrets and are **still in the payload** (rule, length and
     location only; never the value). Show that section verbatim, tell the user which turns of the
     transcript to inspect (the report names the file), and say that values with no recognizable
     format are not detected at all. Only after they explicitly agree, add `--allow-suspicious`
     (`--yes --allow-suspicious`, plus `--allow-findings` if secrets were also redacted). `--yes` and
     `--allow-findings` do not cover them. Never add `--allow-suspicious` on your own.
   - **Blocked (exit 3):** do not publish. Tell the user which rule fired and suggest
     fixing the source or adding an `allowlist` entry in `~/.config/agent-share/config.json`.

4. Reply with the `Shared:` viewer URL and the gist URL from the output. Mention that
   the link is unlisted but public (anyone with it can read it) and that deleting the
   gist is the only way to unpublish.

Notes:
- The export is a snapshot up to the moment `publish` runs.
- Do not paste raw transcript content or secret values into the conversation while doing this.
