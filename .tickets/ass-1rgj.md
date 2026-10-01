---
id: ass-1rgj
status: closed
deps: []
links: [ass-azwt, ass-oayq, ass-mpbn, ass-pifw]
created: 2026-10-01T01:15:13Z
type: bug
priority: 2
assignee: cc-vps
tags: [browse, shares, delete]
---
# browse: delete leaves a stale ✓ in shares.json (agent-share delete does not update it)

Follow-up from PR #21 (`agent-share browse`, follow-up item 3).

## Problem
`agent-share browse` marks sessions you already shared with a ✓ (and the `shared:yes|no` filter and the preview's "✓ shared 1h ago" line use the same data). That data is `~/.local/state/agent-share-session/shares.json` (`AGENT_SHARE_SHARES` / `XDG_STATE_HOME` override), written by `recordShare` in `src/sessions/shares.ts` on every successful publish.

`agent-share delete <share>` (`src/cli.ts`, `delete` command) removes the remote share via `createPublisher(config, ref.target).delete(ref.id)` but never touches `shares.json`. After deleting a share, the browser still shows ✓ and "shared <time> ago (mode)" with a link that no longer exists, and `shared:no` omits the session. That is misleading when the point of the mark is "have I already published this?".

## Why
The mark is only useful if it is true. Deleting is the one operation that invalidates it, and the data to fix it is already available at delete time.

## Design notes
- Add `removeShare(...)` to `src/sessions/shares.ts`, same atomic-write and never-throws behaviour as `recordShare` (a failure to update `shares.json` must only warn, never fail a delete that already succeeded; mirror `publishPrepared`'s warning wording).
- Records are keyed `<harness>:<sessionId>` -> `ShareRecord[]` and each holds `url` (the viewer link), `target`, `mode`, `sharedAt`. `delete` only knows the share `id` + `target` (from `parseShareRef` in `src/publish/index.ts`), not the session key, so match by parsing each record's stored `url` with `parseShareRef` (or comparing the share id + target) and remove every record that refers to the deleted share. Drop the key entirely when its list becomes empty.
- A share deleted that was never recorded (published before `shares.json` existed, or from another machine) is a normal case: do nothing, no warning.
- Out of scope: a delete / "open link in browser" action inside the browser itself (tracked separately as part of the CLI-parity wishlist; do not add it here).

## Acceptance
- After `agent-share delete <viewer link | gist URL | r2:<id> | id>` succeeds, the matching record(s) are gone from `shares.json`; other records for the same session (e.g. a second share in another mode/target) are kept; a session with no records left has no key.
- All the input forms `parseShareRef` accepts match the stored record (viewer link, gist URL, `r2:<id>`, bare id with and without `--target`).
- Deleting an unrecorded share succeeds silently; an unwritable/corrupt `shares.json` produces a warning but exit code and the "Deleted ..." message are unchanged.
- `delete` declined or failed at the remote leaves `shares.json` untouched.
- Tests: unit tests for `removeShare` (single/multiple records, unknown id, unwritable path) in `tests/sessions-index.vitest.ts` or a new file, plus a CLI-level or publisher-fake test covering `delete` updating the file (use `AGENT_SHARE_SHARES` pointing at a temp file; see `tests/cli.vitest.ts` and the existing delete tests for fakes).
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-10-01T22:11:22Z**

Fixed: agent-share delete now removes the deleted share's records from shares.json (removeShares in src/sessions/shares.ts, forgetShare in src/publish/index.ts), after the remote delete succeeds. Warns only if shares.json is corrupt or unwritable.
