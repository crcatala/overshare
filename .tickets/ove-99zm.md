---
id: ove-99zm
status: closed
deps: [ove-m3y1, ove-nl3h]
links: []
created: 2026-11-20T18:20:21Z
type: task
priority: 3
assignee: cc-vps
parent: ove-v5c6
tags: [fixtures, codex, antigravity]
---
# Demo fixtures: fake Codex and Antigravity sessions in overshare demo

src/fixtures/ generates the fake Claude Code and pi sessions that overshare demo, the docs demo and many tests use, from one script (src/fixtures/script.ts). Add Codex and Antigravity writers so the demo shows all four harnesses, and the CLI hint in src/cli.ts lists their env vars.

