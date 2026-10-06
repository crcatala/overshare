# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `overshare browse` shows a shared session's latest link in the preview and the session viewer,
  and `y` prints the whole link in the footer, so it can be copied by hand in terminals without
  OSC 52 clipboard support.
- `--include-system-prompt` (with `--mode full`) shares Claude Code's system prompt, redacted like the
  rest and shown collapsed above the first turn. Instruction files (`CLAUDE.md`, `AGENTS.md`) are still
  never shared; [docs/redaction.md](docs/redaction.md#injected-context) explains why.
- The token rail's charts are easier to read and navigate: hovering a bar shows a card with its
  context split into cache read, cache write and uncached input (drawn to scale), its output and
  cost, any cache events and, for the turn chart, the prompt, a small chart of the turn's model calls
  and its tool calls. Model-call bars in the turn box now go to the step the call produced when
  clicked, and their card lists what the call did (thinking, reply, tool calls).

### Removed

- The viewer's `timeline` and `hybrid` design variants, and the IBM Plex Sans font only `hybrid`
  used. Links and saved defaults that name either fall back to the reader's own variant.

### Security

- `overshare serve` and `demo` refuse requests whose `Host` names a domain other than localhost, an
  IP address, the `--host` value or a name passed to the new `--allowed-host`, so a web page can't
  read the served shares through DNS rebinding.
- `overshare serve` no longer serves files beside the viewer directory whose names share its
  prefix (e.g. `viewer/dist/standalone.html` via `/s/..%2fstandalone.html`).

## [0.1.0] - 2026-10-05

### Added

- Initial public release of the `overshare` CLI (also installed as `ovs`).
- Share Claude Code and pi sessions as unlisted links through a secret GitHub gist or a public
  Cloudflare R2 bucket, with `report`, `export`, `publish` and `delete` commands.
- Four share modes (`full`, `brief`, `minimal`, `prompts`), applied before redaction so omitted
  detail is never uploaded.
- Layered local redaction: structural drops, exact known values (environment, project `.env`
  files, opt-in credential stores, `--secrets-file`), secret patterns, path and email scrubbing,
  and a final re-scan of the exact payload that blocks publishing on leftovers.
- `overshare browse`, an interactive terminal browser to search, preview and publish local
  sessions.
- A static, backend-free web viewer with design variants, token and cost rails, cache-miss
  detection and subagent usage, plus self-hosting on Cloudflare.
- Single-file HTML export (`overshare export -o session.html`) that opens offline.
- `overshare demo`, `serve` and `fixtures` for trying the viewer on fake sessions without
  uploading anything.
- Claude Code skill and pi extension integrations (`/share-session`).
