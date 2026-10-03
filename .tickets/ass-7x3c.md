---
id: ass-7x3c
status: closed
deps: []
links: []
created: 2026-10-03T17:57:51Z
type: bug
priority: 1
assignee: cc-vps
tags: [security, redaction]
---
# Secret prefix survives where adapters and modes truncate text before redaction (tool summary, subagent description, maxToolChars cut)

Same class as ass-ahh1, found while fixing it. Text is cut BEFORE redaction in three more places that reach the published payload, so a secret straddling the cut leaves an unmatched prefix and the final re-scan does not flag it (report.blocked=false). Measured with planted fakes (github-style token, 8-char windows of the token found in the payload JSON; counts only): (1) tool step 'summary' (src/adapters/shared.ts firstLine, cut at 160): command with the token at char 150 -> 2 windows in full and brief, 0 in minimal (minimal keeps no summary); (2) subagent 'description' derived from args.prompt/task (firstLine 160, a prompt prefix): 2 windows in full, brief and minimal; (3) src/modes.ts truncate/truncateDeep (maxToolChars, default 20000) cuts tool input and tool result text before redaction: token at the cut -> 3 windows in full (brief/minimal drop the text). Fix direction: keep the adapters' text whole and cap after redaction (as prepareShare now does for the title via capTitle, which never cuts a [REDACTED:..] token), or redact before truncating; the browse view uses the same parsed steps, so check its labels. Needs a regression test per site in all modes and both adapters, like tests/title-secret-prefix.vitest.ts.

## Acceptance Criteria

No fragment of a planted secret in the payload or any report string when it straddles the summary, description or maxToolChars cut; existing leak/own-fields/suspicious tests unchanged.


## Notes

**2026-10-03T19:05:09Z**

DECISION (user, 2026-10-03), approach for the agent that takes this: (1) tool summary and subagent description: keep the adapters' text whole and cap AFTER redaction in the pipeline, as prepareShare does for the title via capTitle (never cut a [REDACTED:..] token). Adapters stay pure; check the browse view labels that use the same parsed steps still fit (cap there for display). (2) maxToolChars cut in src/modes.ts: first MEASURE the cost of redacting each whole tool input/result before cutting to maxToolChars (rescan notes the pattern scanner is superlinear on very large single strings; use a large fixture, report ms). If acceptable, redact-then-cap here too (soundness over a few ms; findings in the cut-off text get reported, that noise is accepted). If not acceptable, fall back to cutting back to the last whitespace/newline before the cut, and say plainly in code and PR that this is a heuristic (does not cover secrets containing whitespace or with no whitespace near the cut). (3) Regression test per site in all modes and both adapters, shaped like tests/title-secret-prefix.vitest.ts (8-char windows on payload and every report/browse string, counts only). Do this BEFORE ass-uho0. Do not redact inside adapters.

**2026-10-03T19:33:28Z**

Measured (planted fakes, one string, Redactor.redactText with known secret + all rules): ~0.3-0.7 ms per KB, linear: log lines 1 MB 303 ms / 5 MB 1.5 s / 20 MB 6 s; base64 blob 1 MB 739 ms / 20 MB 15 s; one-line prose and JSON alike. The scanner already runs in 32 KB windows. The only superlinear part was Redactor.redactText splicing the string once per match: 15k matches in 5 MB took 21 s, 44k in 20 MB 275 s. Fixed by joining the pieces once (same output): 2.0 s and 9.9 s. Acceptable, so redact-then-cap (no whitespace heuristic). Previously redaction cost was bounded by 20000 chars per string.

**2026-10-03T19:33:28Z**

Done: adapters keep summary/description whole (firstLine has no cap); pipeline caps summary (non-path tools), description and brief commands at 160 after redaction (capRedacted, src/cap.ts, shared with capTitle); capToolText (modes.ts) cuts tool input strings, tool results and subagent results at maxToolChars after redaction, never splitting a [REDACTED:..] token; browse labels capped for display. New tests/truncate-before-redact.vitest.ts (1211 tests), mutation-verified per site. SCHEMA_VERSION unchanged: field shapes are the same. Findings in cut-off text are now reported (accepted). Found a fourth site, out of scope: ass-yyg0 (subagent answer cut at 4000 in the adapter).
