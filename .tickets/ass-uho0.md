---
id: ass-uho0
status: open
deps: []
links: []
created: 2026-10-03T17:57:51Z
type: task
priority: 2
assignee: cc-vps
tags: [security, redaction]
---
# Final re-scan: block a payload that holds a long prefix or suffix of a known or already-redacted secret

Defense in depth for the ass-ahh1 class (a truncated secret matches no rule). Idea: SecretValue gets a matcher (e.g. hasFragmentIn(text, len) checking the first and last len chars; never exposing the value), and rescanPayload flags a known value's prefix/suffix; for pattern-matched secrets the Redactor would also have to keep (privately) the matched values. Not done in ass-ahh1 because of false-positive risk that needs measuring first: known values from env/.env often start or end with common text (a URL scheme and host, 'postgres://user:', a path), and a 12-20 char fragment of that is legitimate transcript text, so a naive check would block ordinary shares. Needs: a minimum value length, a minimum fragment length scaled to the value, an entropy/charclass filter on the fragment, and a measurement on the fake fixtures plus a dry run against many real-shaped sessions (counts only) before it can ship. Blocked on nothing; do after the truncation sites in the sibling ticket are fixed so the check is not the only guard.

## Acceptance Criteria

Check lands with a measured false-positive rate on the fixture sessions, or is dropped with the measurement recorded.

