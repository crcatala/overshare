---
id: ass-azwt
status: closed
deps: [ass-13r0, ass-8w1o]
links: [ass-oayq, ass-mpbn, ass-1rgj, ass-pifw, ass-13r0, ass-iugy, ass-5qv5, ass-8w1o]
created: 2026-10-01T01:15:35Z
type: task
priority: 3
assignee: cc-vps
tags: [browse, redaction, performance]
---
# Cache locally collected known secrets so the browse publish dialog scans faster

Follow-up from PR #21 (`agent-share browse`, follow-up item 2).

## Problem
`prepareShare` (`src/pipeline.ts`) calls `collectKnownSecrets({ home, projectDir: session.project.cwd })` (`src/redact/known-values.ts`) on **every** call unless the caller passes `knownSecrets`. That function reads env vars, several credential JSON files, `~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.netrc`, the project's `.env*` files, and **spawns `gh auth token`** (timeout 5 s). Measured overhead is ~0.4 s per scan.

In `agent-share browse` the publish dialog runs `prepareShare` for each share mode the user looks at (full / brief / minimal / prompts), and again after a re-scan, so each mode switch pays this ~0.4 s again, on top of the real parse/redact work. The same machine-wide secrets are re-collected every time, and they only differ by project directory.

## Why
It is the cheapest, safest speed-up for the publish dialog, and it is independent of the bigger async work (see the "stop freezing the UI" ticket). `prepareShare` already accepts `opts.knownSecrets`, so no pipeline change is needed to inject a cached value.

## Design notes
- Cache in the browse `Source` (`createSource` in `src/browse/source.ts`), not in `collectKnownSecrets` or `prepareShare`, so `agent-share publish` and tests keep their exact current behaviour. Key by `home` + project dir (session cwd). The cwd is on `SessionSummary.cwd`; for sessions with no cwd use a single "no project" key. Note `prepareShare` derives the project dir from the *parsed* session (`full.project?.cwd`); make sure the cache key you use matches that (or document the difference).
- **Safety first**: this is the redaction pipeline. A stale cache must not be able to let a secret through. Invalidate on a short TTL (suggested: a few minutes) and/or when any of the `.env*` / credential files' mtimes change; and always run the final re-scan with the same list used to redact. Document the chosen invalidation in a code comment. Do not cache across process runs (no on-disk cache of secret values).
- Values never leave the process and are never printed (reports show label + source only); do not add any logging of values.
- Do not change which sources are collected.

## Acceptance
- Within one browse run, reviewing a second mode (or re-reviewing after a file change) for sessions in the same project does not call `collectKnownSecrets` again (assert with an injected/spied collector or by timing with a fake `gh`); a different project dir does.
- Secrets added to a project's `.env` (or changed credential file) after the cache was filled are still redacted in a later review, via TTL or mtime invalidation (test with a temp project dir and fake timers or an explicit invalidation hook).
- The "reviewed payload == uploaded payload" behaviour and the re-scan findings are unchanged (existing `tests/browse-source.vitest.ts` real-pipeline tests with planted fake secrets still pass: the upload never contains the raw secret).
- `agent-share publish` behaviour is unchanged.
- Ticket note records the before/after time for a review on a real session.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-10-02T19:40:57Z**

2026-10-02 PRODUCT DECISION NEEDED before implementing: do not build this as written. Review of the redaction design raised that harvesting real machine secret values is a deliberate, risky tradeoff, and we decided to (a) make the sensitive sources (credential files, ~/.npmrc, ~/.netrc, hosts.yml, gh auth token) opt-in and keep only env + project .env* by default (ass-13r0), (b) wrap KnownSecret values so they cannot be printed/serialized (ass-8w1o) - a cache would hold exactly these objects, and (c) tighten reporting (ass-5qv5, ass-iugy). A smaller default source set may make the ~0.4 s collection cost mostly disappear (no gh spawn, no credential-file reads), so this cache may be unnecessary. Blocked on ass-13r0 and ass-8w1o. After they land: re-measure collectKnownSecrets cost with the new defaults, then either close this ticket as not needed or re-scope it (if kept: in-memory only, cache the wrapper type, keep the safety/invalidation rules below).

**2026-10-03T14:59:17Z**

Won't do (measured 2026-10-03, after ass-13r0 and ass-8w1o landed). Timings only, no values printed; own machine, 15 runs. collectKnownSecrets with the new defaults (env + project .env, 19 values): median 0.1 ms, max 0.2 ms. With all four sources on (credential files + gh auth token spawn, 32 values): median 42.7 ms, max 44.5 ms (not the ~0.4 s the ticket assumed). prepareShare, full mode, collecting vs injecting a pre-collected list: 7.8 MB session 278 vs 270 ms (saves 7 ms); 0.5 MB session 212 vs 212 ms (saves 0). So the cost came from the sensitive sources, which are opt-in now, and a cache would save ~0.1 ms by default and at most ~43 ms for someone with every source on, against 210-280 ms of parse/redact/re-scan (that is ass-mpbn territory). A cache would also keep harvested KnownSecret objects alive for minutes with TTL/mtime invalidation that could go stale: a security cost for no visible gain. Closing; reopen only if collection gets more expensive (new sources).
