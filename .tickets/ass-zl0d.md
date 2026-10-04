---
id: ass-zl0d
status: in_progress
deps: []
links: [ass-6jd4]
created: 2026-10-04T16:25:13Z
type: task
priority: 2
assignee: cc-vps
tags: [refactor, architecture]
---
# Harness registry: one folder and one descriptor per harness

## Problem
Harness identity (`"claude-code"` / `"pi"`) is hardcoded in about a dozen places outside the adapters. The adapter -> `NormalizedSession` seam is clean (everything downstream of parsing is harness-agnostic), but everything *around* it is not. The README's "Adding a harness" lists 3 steps; in reality following them gives a harness that works for `export <path>` / `publish <path>` and is silently missing from `list`, `browse`, `--current`, `--harness`, the filter chips, labels and summaries. A contributor (or a fork) has to grep for string literals to find the other places, and the compiler does not help.

Known leak sites (from grep on main at fe36aa3; re-verify while implementing):
- `src/schema.ts`: `HarnessName` is a hand-written closed union.
- `src/resolve.ts`: `SessionRoots` has literal keys; `defaultRoots` (env vars, dirs), `projectDirName`, `sessionIdFromFile`, `listSessions` (the `.jsonl` / `agent-*` / `.session*` rules), `resolveSession` (`["claude-code","pi"]`, `CLAUDE_CODE_SESSION_ID`), `sniffHarness` (a second, regex-based detector next to `ADAPTERS[].detect`, that defaults to claude-code).
- `src/adapters/index.ts`: `ADAPTERS` array + `UnrecognizedFormatError` message ("supported: claude-code, pi").
- `src/sessions/summary.ts`: `summarizeClaude` / `summarizePi` selected by `if (harness === "claude-code")`; `subagentCount` is Claude-only.
- `src/sessions/index.ts`: default harness list. `src/sessions/query.ts`: `HARNESS_ALIASES`.
- `src/cli.ts` (x3 `.choices([...])` and a list) and `src/browse/job.ts`: `loadSubagentFiles` only when `claude-code`.
- `src/browse/app.ts` (filter cycle `HARNESSES`, the dialog option list, group label, chip label, badge colour + `π`/`CC` tag) and `src/browse/viewer.ts` (label).
- `src/cache.ts`: `claudeCode` special case (cache TTL when explicit cache control is seen).
- `src/modes.ts`: `promptsUnavailableReason` is pi-only.
- `src/redact/known-values.ts`: per-harness credential file paths.
- `viewer/src/header.ts` (`HARNESS_LABEL`), `viewer/src/transcript.ts` (`harness.name === "claude-code"` gates the subagent chip).

## Why
- The user supports only Claude Code and pi on purpose and does not want to maintain others. But the tool is open source, other harnesses (Codex, opencode, ...) are popular, and the cheapest way to let someone else carry that is to make "add a harness" a single, obvious, compiler-guided change that lives in one folder. A fork should be able to do it without reading the whole codebase.
- It also removes the `=== "claude-code"` branching, which is a smell even with two harnesses: each new harness-specific quirk gets another `if`.
- Explicitly NOT a runtime plugin system (rejected: needs a stable public API, contradicts "private tool, break freely", and plugin code would read raw unredacted transcripts). See the separate ticket for the out-of-process converter idea.

## Design
One folder per harness, one registry, exhaustive by type.

```
src/harnesses/
  meta.ts            node-free: HARNESS_META { name, label, short, tag, color, aliases } ; HarnessName = keyof it.
                     Shared with the viewer bundle (which must not import Node), so labels live in one place.
  types.ts           the `Harness` descriptor interface (Node allowed)
  index.ts           HARNESSES: Record<HarnessName, Harness>  (missing entry = type error), lookup/detect/parse helpers
  shared.ts          what adapters share today (was src/adapters/shared.ts): TurnBuilder, describeTool, ...
  claude-code/       index.ts (descriptor) + parse + usage + summarize + subagent files + discovery
  pi/                index.ts (descriptor) + parse + summarize + discovery
```

`Harness` descriptor owns everything harness-specific: `name`; sessions root (env vars + default dir); how to list session files (optionally for one cwd); session id from a file; content `detect`; `parse`; `summarize` (browse index); and optional capabilities: `currentSession` (e.g. `$CLAUDE_CODE_SESSION_ID`), `subagents` (load files, count), `credentialFiles` (for known-secret harvesting), `promptsUnavailableReason`. Generic code reads capabilities, never harness names.

Constraints from the code on main:
- Share output must not change: `harness.name` values stay `"claude-code"` / `"pi"`, no `SCHEMA_VERSION` bump, the frozen shares in `tests/fixtures/shares/` (viewer-compat tests) must still pass untouched.
- `src/schema.ts` and everything the viewer imports must stay free of Node imports. Hence `meta.ts` (data only) is separate from the Node-side descriptors.
- Per project convention (private tool): no compat shims. Move files, update imports, delete `src/adapters/`.
- Behaviour-preserving refactor: the existing test suite is the safety net; add tests only for new seams (registry exhaustiveness, detection, the consolidated sniff).

## Out of scope
- Any new harness. Runtime/plugin loading. Changing the normalized schema. The fake-session generators in `src/fixtures/` stay where they are (test data, not runtime), though the README should say a new harness wants one.

## Acceptance criteria
- [ ] `src/harnesses/<name>/` holds every harness-specific piece for claude-code and pi (parse, summarize, discovery, subagents, credential files); `src/adapters/` is gone.
- [ ] `HarnessName` derives from one data table; `HARNESSES` is typed `Record<HarnessName, Harness>` so adding a name without a descriptor fails `npm run typecheck`.
- [ ] No `=== "claude-code"` / `=== "pi"` / `["claude-code","pi"]` literals remain in `src/` or `viewer/src/` outside the harness folders and `meta.ts` (check with grep; any survivor is justified in a comment).
- [ ] CLI `--harness` choices, `list`, `browse` filter cycle/dialog/chips/badges, query aliases, viewer labels and the "supported formats" error are all generated from the registry.
- [ ] One harness detector (the `sniffHarness` regex duplicate is removed); behaviour on an unrecognised file is deliberate and covered by a test.
- [ ] Behaviour unchanged: full test suite passes, frozen-share viewer-compat tests pass unmodified, `agent-share fixtures` output is byte-identical before and after (diff the generated shares).
- [ ] README "Adding a harness" rewritten to the real, short procedure, and verified by actually walking it with a throwaway toy harness (not committed) to confirm that the compiler points at every required edit and that `list`/`browse`/`--harness` pick it up.
- [ ] `npm run typecheck` and `npm test` pass; PR description records the key decisions and rationale.

