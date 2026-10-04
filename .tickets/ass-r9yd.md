---
id: ass-r9yd
status: open
deps: []
links: [ass-ques]
created: 2026-10-04T18:22:23Z
type: feature
priority: 4
assignee: cc-vps
tags: [browse, export, idea, needs-decision, needs-investigation]
---
# browse: 'save as HTML file' destination behind the review gate (needs product review)

## Context
PR #49 / ass-ques adds `agent-share export --format html`: one self-contained page (viewer + redacted session), CLI only. Today `export` prints the redaction report and writes the file with no confirm step, unlike `publish` and the `browse` TUI, which walk mode -> review -> explicit `y`. The HTML file is also the easiest export to forward (double-click, no tooling) and, unlike a link, cannot be revoked. PR #49 mitigates with a reminder printed after every HTML export (even with -q). This ticket is about whether to go further and offer the format from `browse`, where the review gate already exists.

## Idea
In the `browse` publish dialog (`p`), add a second destination next to the upload: **save as HTML file**. Same steps as a publish: choose mode -> review (findings, suspicious values, blocked state) -> confirm with text that says the file cannot be revoked and carries a frozen viewer. The prepared payload that was reviewed is exactly what is written (same "reviewed == uploaded" guarantee `Source.review` / `Source.publish` give today).

## Design constraints / decisions already leaning one way (from the PR discussion)
- A separate **destination**, not a `publish` target (`--target file`) and not a mode. `publish` means "upload somewhere you control, get a link": it records the share in `shares.json` (the browser marks the session as shared) and `agent-share delete` can remove it. A local file has no URL, can't be deleted, and must not be recorded as shared; calling it a publish target would blur the one property that matters (revocable vs not).
- Hosting is a different thing: `publish --target r2 --format html` (a URL we can delete) belongs under `publish` with its existing gate, and is out of scope here. It needs the object stored as `content-type: text/html` and, ideally, the CSP sent as a header (the file only has a `<meta>` one).
- Leave the Claude Code skill and the pi extension out: they wrap `publish`, and an agent should not produce forwardable files unprompted.
- Keep `export`'s behaviour of refusing to write HTML when the final re-scan blocks the share.

## Open questions (need product input before building)
- Do we want people to produce these files at all, given no revocation and a frozen viewer? If the answer is "only via a hosted URL", close this and do the r2 HTML target instead.
- Where does the file go? Default dir (cwd? `~/Downloads`? an `out/` dir?), file name (session title + id?), overwrite behaviour, and how the TUI shows the resulting path (OSC 52 copy of the path? just print on exit?).
- Confirm text and wording: how loud should the no-revocation warning be in the dialog versus the existing publish confirm? Should it require typing `y` the same way?
- Does the browser's "shared" mark need a second state ("saved as file"), or is nothing recorded? Leaning: record nothing, so the mark keeps meaning "has a link we can delete".
- Large `full` exports: add a size warning (and maybe suggest `brief`) before saving, since these can be many MB and render slowly.
- Fonts: full vs latin-only subset would change the file size by ~300 KB; decide in ass-ques.

## Investigation needed
- Read `src/browse/flow.ts`, `dialogs.ts`, `source.ts`, `job.ts`, `app.ts` to see how much of the publish dialog (mode picker, async review, confirm) is destination-agnostic. The `Source` interface has `view` / `review` / `publish`; a `save` sibling that takes the already-reviewed `PreparedShare` may be the natural seam. Check the tests that pin "nothing is sent before an explicit y" and the stale-review handling when the mode changes.
- Check the worker path (ass-mpbn part b, may land first) so the HTML build happens off the main thread for big sessions (embedding is a string splice, so cheap, but reading the 0.9 MB template and writing 5+ MB files is not nothing).
- Terminal safety: a file path chosen/typed in the TUI must be validated like other TUI input (no escape sequences in printed names; see src/sanitize.ts).

## Done when
A decision is recorded (build / don't build / fold into the r2 target), and if build: a scoped follow-up with the answers above and acceptance criteria.

## Acceptance Criteria

decision recorded; if build, a follow-up ticket with the open questions answered

