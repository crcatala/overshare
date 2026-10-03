---
id: ass-ahh1
status: closed
deps: []
links: []
created: 2026-10-03T17:06:21Z
type: bug
priority: 1
assignee: cc-vps
tags: [security, redaction]
---
# Partial secret survives in the share title when the 80-char title truncation splits it

Found while writing tests for ass-mpbn (b), pre-existing on main. prepareShare (src/pipeline.ts) derives a missing title from the first line of the first prompt and cuts it at 80 chars (79 + ellipsis) BEFORE redaction. If a secret straddles the cut, the truncated half no longer matches any pattern or known value, and the final re-scan does not flag it either, so a long prefix of the secret is published in session.title (and shown in the browse list). Repro with fakes: first prompt 'please deploy, my key is <fake anthropic key>' on one line: brief/full/minimal/prompts payloads all contain the first ~54 chars of the 108-char key, report.blocked=false, 1 finding (the user text itself is redacted). Fix idea: redact (or truncate after redacting) the title; add a rescan check that a payload does not contain a >=N-char prefix of a known/pattern secret. Counts only here; never paste a real secret.


## Notes

**2026-10-03T17:57:55Z**

Fixed the title: prepareShare keeps the derived first line whole, redactSession redacts it, then capTitle cuts it at 80 after redaction without splitting a [REDACTED:..] token. Regression tests in tests/title-secret-prefix.vitest.ts (163 cases: claude-code and pi, 4 modes, secret at char 40/60/75/79/80, anthropic key, github token, PEM, known env secret; payload, title, human/json report and browse review checked for 8-char windows of the secret). browse-pipeline test now has the secret on the first line. Index summary title (src/sessions/summary.ts) is raw prompt text, local display only, left as is and commented. Probing found the same flaw at three more truncation sites (tool summary, subagent description, maxToolChars): filed ass-7x3c. Rescan prefix/suffix check not done (false-positive risk, needs measurement): filed ass-uho0.
