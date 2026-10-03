---
id: ass-uho0
status: closed
deps: [ass-7x3c]
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


## Notes

**2026-10-03T19:05:09Z**

DECISION (user, 2026-10-03): do this LAST, after ass-7x3c, and only as a defense-in-depth backstop, never as the primary guard for truncation. Do not ship a check that can block ordinary shares: measure the false-positive rate first (fixture sessions, then counts-only dry runs), and if it cannot be made quiet, drop it and record the measurement here instead. Never expose the raw value (matcher method on SecretValue only).

**2026-10-03T20:29:35Z**

MEASURED + SHIPPED (counts only; scripts/measure-fragment-fp.ts, 72 policies swept). Corpora: (a) fake fixture sessions, 6 seeds x 2 harnesses x 4 modes = 48 payloads, 480 value checks; (b) 12 URL/DSN/webhook/ARN/JWT/path-shaped fake known values whose ordinary start and end the transcript repeats, 4 modes; (c) this machine's real sessions, counts only: 515 sessions, 9785 known-value checks, max 19 known values per session. First try (fragment = 3+ char classes and entropy >= 3.5 over the whole fragment): 4/4 shaped payloads blocked under all 108 policies, because a URL tail like '@db.internal.example.com:5432/appdb' has several classes and enough entropy. Fixed by judging only the fragment's longest run of token chars (A-Za-z0-9+/_=-; ':' '.' '@' end a run), which must be >=16 long, entropy >=3, <40% lowercase 4+ letter words; a JWT header is skipped. Result over the 72 sweeps: fixtures 0 would-block in all 72; real known-value checks 0 would-block in all 72 (loosest: value>=16, fragment>=12); shaped 0 in the 40 policies with run>=16 or entropy>=3.5 (32 looser ones block 4/4). Shipped policy: value>=24 chars, fragment = half the value clamped 20..32, run>=16, entropy>=3, word ratio<0.4: fixtures 0/48, shaped 0/4 modes, real known 0/515; finds a 75% prefix/suffix of 18/22 planted random tokens (misses short/20-char values). Pattern-matched (already redacted) secrets, kept privately as SecretValues by the Redactor (high confidence, max 200): real sessions 2/515 (0.4%) have a long fragment of such a value left in the payload, 1 in this repo's own dev session (planted fakes) and 1 in another project; not verified, transcripts not read. They cannot be allowlisted, so they only ask for a confirmation (suspicious); known-value fragments block. SCHEMA_VERSION not bumped: the payload shape is unchanged, only a new report rule (secret-prefix:/secret-suffix:).
