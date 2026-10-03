---
id: ass-7x3c
status: open
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

