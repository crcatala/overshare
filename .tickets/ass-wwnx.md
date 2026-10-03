---
id: ass-wwnx
status: open
deps: []
links: []
created: 2026-10-03T23:37:38Z
type: feature
priority: 2
assignee: cc-vps
tags: [browse, tui]
---
# Browse TUI tweaks: bounded repo dialog, copy message, last reply preview, formatted viewer, branch guess

From user notes 2026-10-03: (1) repo filter dialog fixed height/min width + scroll indicator; (2) copy selected message to clipboard in viewer; (3) last assistant message in the list preview; (4) markdown/code/diff formatting in the viewer content pane; (5) best-guess branch per session, shown in list when it fits.


## Notes

**2026-10-03T23:51:10Z**

Built on feat/browse-tui-tweaks: dialog window + dot meter, y copies the viewer message, last reply in the list preview, markdown/shell/diff formatting in the content pane, reflog-based branch guess (list column when wide). Alternatives and rationale are in the PR description.
