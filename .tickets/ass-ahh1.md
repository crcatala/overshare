---
id: ass-ahh1
status: open
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

