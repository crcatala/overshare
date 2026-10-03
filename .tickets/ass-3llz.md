---
id: ass-3llz
status: open
deps: []
links: []
created: 2026-10-03T00:57:42Z
type: bug
priority: 4
assignee: cc-vps
---
# adapters: tool_use with a non-string name crashes with a TypeError (name.toLowerCase)

Found while fixing the malformed-transcript leak test in ass-8w1o: a Claude Code tool_use whose name is not a string (e.g. an object) makes parseSession throw 'name.toLowerCase is not a function' instead of being tolerated or rejected with a clear message. No secret is echoed (checked by tests/secret-leaks.vitest.ts), so this is robustness only. Real transcripts are unlikely to have this shape; low priority.

