---
id: ass-5r99
status: closed
deps: [ass-75mx]
links: [ass-75mx, ass-xz9u, ass-z5og, ass-zc54, ass-rc52, ass-cjrn]
created: 2026-09-30T14:55:28Z
type: feature
priority: 3
assignee: cc-vps
tags: [viewer, subagents, tokens]
---
# Viewer: subagent usage line, per-turn attribution and summary

Viewer side of the subagent usage work. Depends on the adapter ticket for the data. Read the ass-rc52 notes and its decisions first.

## Scope
- Rail: show subagent usage as a SEPARATE line beside the main-conversation totals ("main" vs "subagents": model calls, tokens processed, est. cost), never mixed into the main figures. Where scope is labeled "main conversation only" today (PR 1), update the label and tooltip so the caveat is removed for Claude, kept for pi.
- Attribution: the turn that launched a subagent shows its usage (tokens, est. cost, tool uses, duration) in the turn box and turn footer; async completions attribute to the launching turn. Decide how the per-turn chart treats it; recommendation: do not plot subagent tokens as context columns (a subagent's context is not the main window), optionally a small separate marker.
- Header fact: "subagents: N (~$X)" only when N > 0, in the style of the cache-miss header fact.
- Subagent step: shows the file-derived total usage (not the last-call figure) and the bounded summary (`result`), which already renders through the existing subagent step UI; check truncation and the brief/minimal/prompts projections display sensibly (no result, no per-agent rows in prompts).
- Unlinked (other-branch) subagent usage shown like the other-branch usage from PR 1.
- Help/tooltip text; terminology per the ass-lq0c pass ("model call", "tokens processed", ...).
- Old shares without the new fields render as before.

## Acceptance
- Viewer unit tests for the new pieces; browser QA (agent-browser, own named session, tmux server, fixture sessions only): light and dark at 1440px and 390px, Claude fixture with async + foreground + parallel subagents, pi fixture unchanged. Screenshots attached to the PR via the github-pr-screenshots skill; open each before uploading.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-09-30T20:06:59Z**

Heads-up from ass-75mx/ass-cjrn (2026-09-30): no old-share compatibility code. Do not add fallbacks for shares without SessionStats.subagentUsage or SubagentStep.usage beyond the fields being optional; bump SCHEMA_VERSION if a change needs it. SubagentStep.usage has no 'source' field any more (removed); a transcript-derived usage is recognisable by models/turns.

**2026-09-30T22:02:39Z**

Shipped on feat/subagent-viewer. Rail: Session labelled 'main conversation' when subagent usage exists; new Subagents section (subagents, tokens processed, est. cost with per-model hover, model calls) and a 'not launched here' row for unlinked spend; Context-by-turn help says subagents are not drawn (no chart marker: decided against it, the turn box and footer carry the attribution). Header fact 'subagents: N (~$X)' (linked + unlinked; plain launch count where there is no usage, i.e. pi). Turn attribution: sum of the turn's subagent steps (launching turn, async included) in the rail turn box and a footer line; longest run, not summed durations. Step line: 'N tokens · model calls · tool calls · time · cost', cache writes now counted in the fallback sum, wraps on phones, expands to class split/models/nested plus result note. describeCost: caveat dropped where subagentUsage exists or none launched, kept for pi launches. Modes: brief/minimal keep numbers and drop result, prompts has no per-agent rows (turn attribution needs steps; session figures still show since stats are pre-projection). No schema change. Not done: per-turn subagent aggregates in prompts mode (would need TurnActivity fields).
