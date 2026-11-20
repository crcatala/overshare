---
id: ove-5ir1
status: open
deps: []
links: []
created: 2026-11-20T19:26:11Z
type: bug
priority: 3
assignee: cc-vps
---
# Flaky property test: betterleaks keyword prefilter vs reference on the Kelvin sign

tests/betterleaks.vitest.ts 'select the same rules as testing each keyword in the lowercased text' fails on some fast-check seeds (seen 2026-11-20 while working on ove-m3y1; unrelated to that change). Counterexample: ["elevenlabs\u212a"] (Kelvin sign U+212A after a keyword), seed -2117688889, path 90:3:2:7. rulesFor() and the reference lowercasing disagree on U+212A (its lowercase is ASCII k). Decide which behaviour is right and make the prefilter and the reference agree; pin the counterexample as an example test.

