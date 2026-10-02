---
id: ass-5qv5
status: closed
deps: []
links: [ass-13r0, ass-azwt, ass-iugy, ass-8w1o, ass-1c07]
created: 2026-10-02T19:40:50Z
type: bug
priority: 2
assignee: cc-vps
tags: [redaction, security]
---
# redact: stop printing secret content in reports (previews, finding context, data-derived labels)

Part of the redaction-hardening work that came out of reviewing ass-azwt (see "Context" below).

## Problem
`rescanPayload` (`src/redact/rescan.ts`) builds each issue's `preview` as `${v.slice(0, 4)}…(${v.length} chars)`, and `src/report.ts:57` prints it (`✗ rule: sk-a…(108 chars)`). So the report prints the **first 4 characters of a real secret** to the terminal, and anywhere terminal output is captured (CI logs, scrollback, screen shares, pasted bug reports). `agent-share publish --json` may carry it too (check `prepared.report`). For short secrets (8-12 chars) 4 chars is a large fraction.

**Second leak, found in review (reproduced 2026-10-02): finding `context`.** `Redactor.redactText` (`src/redact/index.ts`, the `marks` loop) stores for every redaction `context` = 40 characters of surrounding text on each side of the token, taken from the already-redacted text, and `formatReport` prints it (`src/report.ts`, the `…${f.context}…` line). Any neighboring secret that no layer caught is printed verbatim. Repro: known secret `s3cretvalue1` (label `DB_PASS`) in the text `DB_PASS=s3cretvalue1 and the root pw is Tr0ub4dor&3xyz` yields `context: "DB_PASS=[REDACTED:DB_PASS] and the root pw is Tr0ub4dor&3xyz"`. This is not a new exposure to the share itself (the neighbor is also in the payload, since nothing redacted it), but it is a new exposure to the terminal, CI logs and `--json`, and it contradicts the doc comment on `formatReport` ("never raw secret values"). A missed secret next to a caught one is a common shape (a `.env` dump). The same context string is carried to the browse layer (`src/browse/source.ts`, `Source` review type and `findings.map(...)`).

**Third, minor: data-derived labels.** Several strings that are printed (and in one case published) are built from transcript or credential-file content, not from our own code: `sensitive-key:${key}` and `[REDACTED:${key}]` use the key name from the data (the redaction token lands in the **published** payload), known-secret labels come from credential-file JSON paths (`walkJson` in `known-values.ts`), and `where` includes tool names. Rare and low severity, but a key or tool name can itself be a secret-shaped string.

## Why
The tool's stated rule is "reports show label + source only; values never leave this process" (`src/redact/known-values.ts` header comment). The preview breaks that rule in the exact moment something has gone wrong, which is also the moment people paste output into issues and chats. Four characters also often include the provider prefix plus the first key characters, which helps an attacker brute force or confirm a guess.

## Scope
- Remove the value fragment from `RescanIssue` entirely. Replace `preview` with non-secret metadata only: rule/label, length (length is acceptable), and a location hint once the middle-tier ticket adds one. Do not replace with a hash of the value either (a short hash of a low-entropy secret is guessable).
- **Drop finding `context`** from the human report, the JSON report, and the browse `Source` type (`src/browse/source.ts`). Findings keep rule, category and `where`. If a way to see context is still wanted for local review, make it an explicit opt-in flag documented as risky (it can echo unredacted neighbors); default off. Do not try to "clean" the context by re-scanning it: the neighbor leaks precisely because no layer recognized it.
- **Sanitize data-derived labels** (`sensitive-key:${key}`, `[REDACTED:${key}]`, known-secret labels from JSON paths, `where` tool names): allow only a conservative identifier charset and length (e.g. `^[A-Za-z0-9_.:-]{1,64}$`), otherwise substitute a generic name (`key`, `secret`, `tool`). Applies to the token inserted into the published payload too.
- Update every consumer: `src/report.ts`, the JSON report, the browse publish dialog (`src/browse/*`), and tests/snapshots that assert on `preview` or `context`.
- Per project convention (private tool, no compat shims): just change the shape, bump the schema version if the JSON report is versioned.

## Context
Decision record (2026-10-02): reading real machine secret values for redaction is a deliberate tradeoff (it is the only layer that catches secrets with no recognizable format). We keep it but are tightening everything around it: no printing fragments (this ticket), wrapper type that cannot serialize values, opt-in for surprising sources, and a confirmation tier for suspicious-but-unredacted findings. Related: the wrapper ticket, the harvesting-config ticket, the middle-tier ticket, and ass-azwt (blocked on the decision).

## Acceptance
- No code path prints, logs, or serializes any character of a secret value in rescan issues or the report (human output and `--json`).
- A test plants a fake secret that trips a high-confidence rescan issue and asserts the full human report, the JSON report, and thrown/printed errors contain **no substring of the secret longer than 2 characters** (pick the check so legitimate rule names do not false-fail).
- Known-secret rescan issues still identify the source by label (e.g. `known-secret:GH_TOKEN`) without any value characters.
- Regression test for the context leak: redact `DB_PASS=<known secret> and the root pw is <unformatted secret>` (the neighbor matches no layer) and assert that neither the human report (`formatReport`), the JSON report, nor the browse `Source` review output contains the neighbor text or any finding `context` field.
- Data-derived labels: a transcript key or tool name shaped like a secret (e.g. `{"sk-ant-api03-...": "x"}` under a sensitive-key path, or a tool named like a token) does not appear in the report, and the `[REDACTED:...]` token written into the published payload only ever contains a sanitized label.
- The `formatReport` doc comment ("never raw secret values") is true and is backed by these tests.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-10-02T20:05:57Z**

Implemented. Decisions: (1) RescanIssue is now {rule, length?}; no value fragment and no hash. (2) Finding context dropped entirely (type, human report, JSON report, browse ShareSummary); no opt-in flag added since nothing needs it, and the Redactor now records findings at redaction time instead of slicing context afterwards. (3) src/redact/labels.ts safeLabel(): charset [A-Za-z0-9_.:-]{1,64}, rejects anything findSecretPatterns/looksLikeSecret flags (SCREAMING_SNAKE names with an underscore are exempt from the entropy heuristic); applied to known-secret labels (Redactor + rescan), sensitive-key names, where tool names, and stats.tools keys (the latter also fixes the published payload, where tool names in stats were never redacted). (4) JSON report is not versioned and the session payload shape is unchanged, so no SCHEMA_VERSION bump. Follow-up for the smaller leftovers (sessionId, known-secret source, model names): ass-1c07. Proof: tests/report-leaks.vitest.ts (fails on main with leaked fragments 'ghp','hp_' and the neighbor text; passes now). npm test 865 pass, typecheck and build clean.

**2026-10-02T20:30:37Z**

Review follow-up: (1) secrets-file ambiguous 'name=value' lines used the text before '=' (part of the secret) as the label of the tail entry, which landed in the published [REDACTED:<label>] token; now labelled 'secret', and withSafeLabels() additionally drops any label that appears inside a known value (Redactor + rescan). (2) integrations/pi/agent-share.ts and the claude-code SKILL.md still consumed finding context / rescan preview; updated. integrations/ is not covered by npm run typecheck, which is why this was missed. (3) README guarantee qualified, pointing at ass-1c07.
