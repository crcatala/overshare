# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
