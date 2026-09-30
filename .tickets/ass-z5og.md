---
id: ass-z5og
status: open
deps: [ass-75mx]
links: [ass-75mx, ass-xz9u, ass-5r99, ass-zc54, ass-rc52, ass-cjrn]
created: 2026-09-30T14:55:28Z
type: feature
priority: 4
assignee: cc-vps
tags: [viewer, subagents, claude-code, deferred]
---
# Expandable subagent transcripts in shares (deferred)

DEFERRED, low priority. Option C from the ass-rc52 investigation: publish and render subagent transcripts (expandable inside the launching step). Decided out of scope for v1; the usage-and-summary tickets are designed so this can attach later without a migration (per-agent rows keyed by `toolUseId`).

Why deferred: each subagent file is about 113 KB even for a one-line task (system prompt and attachments dominate), so 20 agents is 2+ MB before real work; every file needs redaction and share-mode projection identical to the main transcript; the viewer would need nested-session UI; and the on-disk layout has already changed between Claude Code versions (background subagents became the default in 2.1.285). Only build this if there is real demand for seeing what subagents did.

Questions to answer first: publish size budget and per-agent cap; whether brief/minimal/prompts modes show any subagent transcript (recommend full only); how to trim the system-prompt payload; resumed and nested subagents in the UI.

