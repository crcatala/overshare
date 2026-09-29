---
id: ass-llot
status: open
deps: []
links: []
created: 2026-09-29T19:47:05Z
type: feature
priority: 3
assignee: cc-vps
tags: [viewer, search, rail]
---
# Rail filter: search full message and tool-call text, not just labels

## Context

The contents-rail filter (viewer/src/toc.ts, viewer/src/filter.ts) is label-only: it searches the text the rail already shows. Punctuation and case are ignored, and every word in the query must appear in a single label, in any order. Matches are highlighted in the label. This was a deliberate first step (see the PR that added highlighting).

## Limitations of label-only

The rail labels are short summaries, not the content:

- A prompt's label is its text collapsed to one line and cut at ~140 chars (transcript.ts, `turn` label).
- A reply's label is only its first non-empty line, markdown stripped, cut at ~120 chars (`plainLine`).
- A tool run's label is only tool/program names and counts, e.g. `Bash(git) ×3 · Edit`. File paths, commands, arguments, and output are not in it.
- A subagent's label is `tool · description`. Events use their short text.
- Thinking steps are not in the outline at all.

So a word in the middle of a long prompt, in the body of a reply, in a file path an Edit touched, in a command, or in tool output cannot be found. The user has to remember which turn it was in and scroll. "Where did I run the migration?" or "which turn touched invoices/create.ts?" gets no answer.

Words are also matched per label, never across a prompt and its replies, so a query whose words are split across them finds nothing.

## What full-text search would add

- Find any word from the transcript: prompt bodies, whole replies, thinking, tool inputs (commands, paths, patterns), and possibly tool output.
- Answer "which turn?" questions by narrowing the rail to the turns that contain the text.
- Optionally highlight the matches in the transcript itself and step through them (next/previous), like find-in-page but scoped to the session data and aware of collapsed/truncated content (tool output previews, "+N lines", brief/minimal views where content is not published).

## Design notes / open questions

- Highlighting: today a row appears only if its label matches, so a highlight is always visible. With full-text, a row can match on text that is not in its label. Show a snippet around the first hit (with the hit highlighted) under the label, or a "match in body" marker. Without that, rows appear with nothing highlighted.
- Index: build lazily on first focus of the search box, from the session data (not the DOM), one folded string per step. Reuse `fold`/`queryTokens`/`matchesAll`/`hitRanges` from filter.ts, so punctuation-blind, order-blind, all-words matching stays the same. Sessions can be large (tool output especially), so measure first. Options: cap tool output indexed per step, index inputs but not outputs by default, or make it a toggle (labels / everything).
- Granularity: match per step, and show the turn if any step matches. Decide whether all words must be in one step or may span the turn. (Label-only chose one label, so highlights explain the match.)
- Share modes: brief/minimal views hold less content. Search only what the current view actually has, so results never point at text the viewer can't show.
- Privacy/redaction: the index must come from the already-redacted, mode-projected data the viewer renders, never the raw session.
- Performance: the current filter re-runs per animation frame and only redraws changed labels. A full-text pass over a large index needs to stay off the main path per keystroke: a short debounce, or a Worker for big sessions.
- Clicking a result should jump to the matching step (not just the turn) and highlight the hit there.

## Acceptance criteria

- Typing a word that appears only inside a reply body, tool command, file path, or thinking finds the turn.
- The user can see why a row matched (snippet or in-transcript highlight).
- Same matching rules as the label filter: case and punctuation ignored, all words required, any order.
- Only text available in the current view/share mode is searchable.
- Filtering stays responsive on a large session (state the size tested).


## Notes

**2026-09-29T20:20:00Z**

Known limits of the label filter and of transcript outlines (from review of the label-only PR); revisit with full-text search:
- Outlines in a drawn ASCII table are lost when the table re-lays itself out (window resize, font load, table style change): asciitable.ts rebuilds the grid with pre.replaceChildren. A fix needs asciitable and findhits to cooperate, e.g. re-apply the current hits after relayout.
- Matching does not normalize Unicode: a query typed in NFC does not match a label in NFD (for example a macOS filename with an accent), and the reverse. Case and punctuation are folded; combining marks are kept inside words. Folding to NFC needs highlight offsets mapped back to the original text.
- A hit in a collapsed tool block's preview is not carried into the expanded body.
