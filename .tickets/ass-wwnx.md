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

**2026-10-04T00:14:18Z**

Review follow-up: (1) branch guess read FIFOs forever: now opens non-blocking, checks the descriptor is a regular file, bounded read; child-process regression test. (3) long path in edit header / file label was cut at the pane edge: now wrapped. KNOWN LIMITATION, not fixed: lastReply (like lastPrompt/promptTail/prompts) is collected in file order, so after a rewind that ends before the new branch gets a text reply, the preview can show the abandoned branch's reply. Measured 0 mismatches on 74 real Claude sessions; a fix needs parentUuid tracking in the fast index pass.
