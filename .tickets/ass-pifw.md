---
id: ass-pifw
status: open
deps: []
links: [ass-azwt, ass-1rgj, ass-oayq, ass-mpbn]
created: 2026-10-01T02:11:35Z
type: feature
priority: 4
assignee: cc-vps
tags: [browse, search, needs-investigation, needs-product-decision]
---
# browse: search covers assistant replies and tool output, not only your prompts (needs investigation + product decisions)

Follow-up from PR #21 (`agent-share browse`, follow-up item 4). **Not ready to implement: this ticket needs investigation and product decisions first. The first deliverable is a short written recommendation (a ticket note or a design doc), not code.** Do not start building until the open questions below are answered by the maintainer.

## Current behaviour
Search in `agent-share browse` is a substring match over `SessionSummary.searchText` (`src/sessions/summary.ts`, scored in `src/sessions/query.ts`): lower-cased title + project + branch + models + the first ~6 KB (`SEARCH_CHARS = 6_000`) of **your authored prompts**. It deliberately does not cover assistant replies, thinking, or tool calls/results. That keeps the JSON index cache small (~1.8 MB for ~500 sessions), the cold index fast (~5 s) and per-keystroke search instant (~3 ms in memory). PR #21 decision 3 documents this as intentional ("what you remember asking").

## Why this might matter
People often remember what the *assistant* said or what a command printed, not what they typed (an error message, a file name, a function name, "the session where it fixed the race condition"). A prompts-only search misses those, and the first ~6 KB cap also misses prompts late in a long session.

## Open questions (need a decision before any code)
1. **Is it wanted?** Is "find a session by something the assistant or a tool said" a real, frequent need, or is title/prompt/repo/filter search good enough? What queries fail today? (Collect a few real examples from actual use.)
2. **Scope of text:** assistant replies only? Tool output (huge, noisy, may contain secrets, paths, file contents)? Tool inputs (commands, file paths)? Thinking? Subagent transcripts? Each has a different size/noise/privacy profile.
3. **Query model:** plain substring (current), word/AND matching, ranking, phrase search, or true full-text (tokenization, stemming)? Should results show *where* it matched (a snippet, jump to that message in the viewer)? That changes the UI, not just the index.
4. **Latency and cost budget:** acceptable cold-index time, cache size and per-keystroke latency? Is a one-time slower first index OK, or must it stay ~5 s?
5. **Privacy:** an index of assistant/tool text on disk (`~/.cache/agent-share-session/index.json`) would store far more potentially sensitive content (tokens, `.env` contents echoed by tools, private code) than today's short prompts. Should it be indexed at all, held only in memory, redacted before indexing, or scanned on demand?

## Approaches to evaluate (do not pick without answering the above)
- **A. Lazy on-demand scan** (the PR's suggestion): when the query has no hit in `searchText`, or when the user asks (e.g. a key or `body:` token), stream-scan the transcripts for the text, with progress and cancel. No bigger index, no persisted sensitive text, but slow per search on hundreds of large files (some are tens of MB) and it blocks the event loop today (see the "stop freezing the UI" ticket, ass-mpbn, which would be a prerequisite or at least a close companion).
- **B. Bigger capped index**: add a capped chunk of assistant text (and optionally tool names/paths) to `searchText`. Simple and instant, but grows the cache, raises privacy exposure, and a cap means misses for long sessions.
- **C. SQLite FTS (or similar)**: real full-text search with snippets. The PR author's guidance: don't reach for this unless the session count reaches the many-thousands or full-text search becomes an explicit goal. It adds a dependency, migrations, and a native-module/distribution concern for a CLI that currently has none.
- **D. Do nothing**, and document the prompts-only scope in the README/help (it may already be enough to say it clearly).

## Deliverable of this ticket (investigation phase)
- A ticket note (or short doc) that: lists the real queries that fail today; answers questions 1–5 with the maintainer; measures, on a real session set (~500 sessions), the cost of the most promising option (index size, cold index time, search latency, memory); and gives one recommendation among A–D, or "do nothing". Mention whether it depends on the async-index work in ass-mpbn.
- If the decision is to build, split the implementation into follow-up tickets with their own acceptance criteria. Anything touching persisted text must say what is stored and how it is protected.

## Acceptance (for this investigation ticket)
- The five open questions have written answers with the maintainer's decision recorded in a note.
- A measured comparison exists for at least the lazy-scan and capped-index options on a real session set.
- A single recommendation is written down, and either implementation tickets exist or the ticket is closed as "won't do" with the reasoning (and the README documents the prompts-only scope if so).
- No production code changes are required to close this ticket.

