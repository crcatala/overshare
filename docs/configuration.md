# Configuration

overshare works with no configuration: shares go to a secret GitHub gist and open in the hosted
viewer at <https://overshare.link/s/>. Everything below is optional.

## Config file

`~/.config/overshare/config.json` (`$XDG_CONFIG_HOME/overshare/config.json`, or `$OVERSHARE_CONFIG`).
A missing file means defaults; an invalid one is an error.

```json
{
  "viewerUrl": "https://overshare.link/s/",
  "target": "gist",
  "r2": {
    "accountId": "<cloudflare-account-id>",
    "bucket": "overshare",
    "prefix": "s/",
    "publicUrl": "https://shares.example.com"
  },
  "maxToolChars": 20000,
  "redact": {
    "emails": true,
    "username": true,
    "hostname": false,
    "denylist": ["Project Codename"],
    "allowlist": ["a-known-public-test-token"],
    "knownSources": { "env": true, "projectEnv": true, "credentialFiles": false, "ghToken": false }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `viewerUrl` | `https://overshare.link/s/` | Viewer that share links point at. Change it if you [self-host](self-hosting.md). |
| `target` | `gist` | Where `publish` uploads: `gist` or `r2` ([Storage targets](sharing.md#storage-targets)). |
| `r2` | — | Public R2 bucket for `target: "r2"`. Credentials come from environment variables, never this file. |
| `maxToolChars` | `20000` | Per-string cap on tool inputs and results in `full` mode. |
| `redact.emails` | `true` | Replace email addresses with `[email]` (no-reply and example addresses are kept). |
| `redact.username` | `true` | Replace your username with `[user]`. |
| `redact.hostname` | `false` | Also replace this machine's hostname. |
| `redact.denylist` | `[]` | Literal strings to always redact (case-insensitive), such as a codename. |
| `redact.allowlist` | `[]` | Literal strings never to redact or report, such as a known-public test key. |
| `redact.knownSources` | `env`, `projectEnv` on | Which local sources supply exact secret values ([What this tool reads and why](redaction.md#what-this-tool-reads-and-why)). |

## Per-run options

- `--target gist|r2` on `publish` overrides `target`; in `browse`, press `t` in the publish dialog.
- `--secrets-file <file>` (on `report`, `export` and `publish`) adds exact values to redact.
  `UPPER_SNAKE=value` lines are split at the first `=`; any other line is redacted whole, so base64
  padding or an `=` inside a bare secret never drops or partly reveals it. Values under 4 characters
  are skipped with a warning.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OVERSHARE_CONFIG` | Path to the config file. |
| `OVERSHARE_VIEWER_URL` | Overrides `viewerUrl`. |
| `OVERSHARE_TARGET` | Overrides `target` (`gist` or `r2`). |
| `OVERSHARE_R2_ACCESS_KEY_ID`, `OVERSHARE_R2_SECRET_ACCESS_KEY` | R2 API token (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` also work). |
| `OVERSHARE_CLAUDE_PROJECTS` | Where Claude Code sessions live (default `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`). |
| `OVERSHARE_PI_SESSIONS` | Where pi sessions live (default `$PI_CODING_AGENT_SESSION_DIR`, else `~/.pi/agent/sessions`). |
| `OVERSHARE_BROWSE_SETTINGS` | Path to the `browse` settings file. |
| `OVERSHARE_INDEX` | Path to the `browse` session index cache. |
| `OVERSHARE_SHARES` | Path to the record of published shares. |
| `OVERSHARE_BIN` | Used by the agent integrations when `overshare` is not on `PATH`. |

## Files overshare writes

| File | What it holds |
| --- | --- |
| `~/.config/overshare/browse.json` | `browse` preferences ([Settings](browse.md#settings)). |
| `~/.cache/overshare/index.json` | `browse` session summaries, including prompt text (mode 0600). |
| `~/.local/state/overshare/shares.json` | Every successful publish and its link, so `browse` can mark shared sessions (mode 0600). |

Each respects `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME`. Secret values collected for
redaction are never written to disk.
