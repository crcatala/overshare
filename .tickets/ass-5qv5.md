---
id: ass-5qv5
status: open
deps: []
links: [ass-13r0, ass-azwt, ass-iugy, ass-8w1o]
created: 2026-10-02T19:40:50Z
type: bug
priority: 2
assignee: cc-vps
tags: [redaction, security]
---
# redact: stop printing secret fragments in rescan reports

Part of the redaction-hardening work that came out of reviewing ass-azwt (see "Context" below).

## Problem
`rescanPayload` (`src/redact/rescan.ts`) builds each issue's `preview` as `${v.slice(0, 4)}…(${v.length} chars)`, and `src/report.ts:57` prints it (`✗ rule: sk-a…(108 chars)`). So the report prints the **first 4 characters of a real secret** to the terminal, and anywhere terminal output is captured (CI logs, scrollback, screen shares, pasted bug reports). `agent-share publish --json` may carry it too (check `prepared.report`). For short secrets (8-12 chars) 4 chars is a large fraction.

## Why
The tool's stated rule is "reports show label + source only; values never leave this process" (`src/redact/known-values.ts` header comment). The preview breaks that rule in the exact moment something has gone wrong, which is also the moment people paste output into issues and chats. Four characters also often include the provider prefix plus the first key characters, which helps an attacker brute force or confirm a guess.

## Scope
- Remove the value fragment from `RescanIssue` entirely. Replace `preview` with non-secret metadata only: rule/label, length (length is acceptable), and a location hint once the middle-tier ticket adds one. Do not replace with a hash of the value either (a short hash of a low-entropy secret is guessable).
- Update every consumer: `src/report.ts`, the JSON report, the browse publish dialog (`src/browse/*`), and tests/snapshots that assert on `preview`.
- Per project convention (private tool, no compat shims): just change the shape, bump the schema version if the JSON report is versioned.

## Context
Decision record (2026-10-02): reading real machine secret values for redaction is a deliberate tradeoff (it is the only layer that catches secrets with no recognizable format). We keep it but are tightening everything around it: no printing fragments (this ticket), wrapper type that cannot serialize values, opt-in for surprising sources, and a confirmation tier for suspicious-but-unredacted findings. Related: the wrapper ticket, the harvesting-config ticket, the middle-tier ticket, and ass-azwt (blocked on the decision).

## Acceptance
- No code path prints, logs, or serializes any character of a secret value in rescan issues or the report (human output and `--json`).
- A test plants a fake secret that trips a high-confidence rescan issue and asserts the full human report, the JSON report, and thrown/printed errors contain **no substring of the secret longer than 2 characters** (pick the check so legitimate rule names do not false-fail).
- Known-secret rescan issues still identify the source by label (e.g. `known-secret:GH_TOKEN`) without any value characters.
- `npm test`, `npm run typecheck`, `npm run build` pass.

