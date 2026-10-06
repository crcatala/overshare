---
id: ove-yg1d
status: closed
deps: []
links: []
created: 2026-10-05T22:55:17Z
type: feature
priority: 2
assignee: cc-vps
tags: [browse, shares, clipboard]
---
# browse: show the share link in the preview and viewer, and say honestly what y did

`overshare browse` already copies a session's latest share link with `y` (OSC 52), but never shows the URL: the preview says only "✓ shared 2h ago (full)". OSC 52 fails silently in some terminals (macOS Terminal.app, tmux without `set-clipboard on`, some SSH setups), yet the footer still says "link copied", so there is no way to see or select the link without opening `~/.local/state/overshare/shares.json`.

## Design

1. List preview: under the shared line, the latest link, elided in the middle to fit (scheme/host and the share id's tail stay visible), plus '+N earlier' when the session was shared more than once.
2. Session viewer header: the same link line, full when it fits.
3. Footer after y (list and publish-done step): say what actually happened ('sent to clipboard (OSC 52)') and print the full link, since the copy cannot be confirmed.
Safety: a share link is a capability (anyone with it can read the share). Showing it in your own terminal is no new exposure (publish already prints it, y already copies it), except screen sharing. shares.json is local but untrusted for drawing: strip control sequences and whitespace from the stored url before it is drawn OR copied, so the pasted text is exactly what was shown and cannot carry a newline into a shell. Skip records whose url is not a string.
Out of scope: `overshare link <session>` to print the latest link for scripts (follow-up if wanted).

## Acceptance Criteria

Preview and viewer show the latest link for shared sessions and nothing for unshared ones; y copies exactly the displayed (sanitized) link through the app's copy hook; the footer names OSC 52 and shows the link; a url with escape sequences or newlines in shares.json is drawn and copied without them; every screen still fits the terminal at the tested sizes; npm run verify passes.


## Notes

**2026-10-05T22:59:16Z**

Implemented items 1-3 (preview link + '+N earlier', viewer header line, honest OSC 52 footer with the whole link). latestShare() in src/sessions/shares.ts sanitizes the stored url once for both drawing and copying; y now goes through BrowserApp's copy hook. Not done: `overshare link <session>` (out of scope).

**2026-10-05T23:25:43Z**

Review follow-ups: the footer keeps the whole link on narrow terminals (shrinks, then drops its explanation and the key hints; cuts the link only when it alone is wider than the terminal); y after publishing prints the link in the footer too, and the dialog cuts it in the middle; the viewer header shows +N earlier. Possible follow-up: print links copied during a browse session to stdout on quit, for links wider than the terminal.
