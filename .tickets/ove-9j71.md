---
id: ove-9j71
status: closed
deps: [ove-hfgj]
links: []
created: 2026-11-13T15:33:47Z
type: task
priority: 3
assignee: cc-vps
parent: ove-izka
tags: [pricing, scripts]
---
# Preflight checks for price freshness and unpriced models in audit:usage

## Problem

`npm run audit:usage` audits local sessions against whatever price table is committed. It reports unpriced models but doesn't stop, and nothing says the table is stale, so an audit can quietly measure a stale table.

## Approach

- Before auditing, run the price generator in check mode against models.dev. If the committed table differs, warn with the summary and the fix (`npm run update:prices`). Offline or fetch failure: warn and continue.
- `--refresh`: regenerate the table first, then audit (only touches the repo).
- **Unpriced models seen in local sessions:** fail with the model ids and call counts, and the suggested action (`npm run update:prices`, or add to `SUPPLEMENTAL_PRICES` if the source doesn't list it). `--allow-unpriced` downgrades it to a warning.
- No checks of installed pi / Claude Code versions, and never auto-upgrade them (see epic decisions). The audit reads sessions already on disk, so the installed versions don't change its result.

## Acceptance criteria

- With a deliberately stale table: a warning naming the changed models and the command to fix it.
- With a model removed from the table: the audit fails, naming the model and call count; `--allow-unpriced` makes it pass with a warning.
- Without network: the preflight warns and the audit still runs.
- `docs/development.md` describes the flags.

