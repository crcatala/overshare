---
id: ove-1h17
status: open
deps: []
links: []
created: 2026-10-21T13:11:15Z
type: bug
priority: 3
assignee: cc-vps
tags: [redaction, betterleaks, tests]
---
# Fix the keyword-index test's reference for the Kelvin sign (U+212A)

tests/betterleaks.vitest.ts > keywords > "select the same rules as testing each keyword in the lowercased text" fails now and then. rulesFor lowercases ASCII only, while the test reference uses String.prototype.toLowerCase(), which folds the Kelvin sign (U+212A) to `k`. The generator deliberately includes U+212A, so fast-check sometimes finds a text such as "absK" where the reference gives [25] (absk) and rulesFor gives [].

Detection is not affected: JavaScript `/i` does not match U+212A to `k` either, so a rule selected by the reference would not match anyway. The fix belongs in the test: make the reference lowercase ASCII only (matching the index and regex semantics), and keep U+212A in the generator so the case stays covered. Do not change rulesFor to fold U+212A.

Found while writing the Betterleaks sync playbook (ove-mgjr, PR #82); docs/maintaining-rules.md step 6 points here.

