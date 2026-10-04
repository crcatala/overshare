---
id: ass-6jd4
status: open
deps: []
links: [ass-zl0d]
created: 2026-10-04T16:25:13Z
type: feature
priority: 4
assignee: cc-vps
tags: [idea, needs-decision, research]
---
# Idea: accept externally-normalized sessions (converter instead of plugin)

## Idea
Let someone support a harness we don't (Codex, opencode, Gemini CLI, ...) without it being merged into this repo or maintained by us: accept an already-normalized `agentshare/2` session as input. A standalone converter (their own repo, any language) turns native transcripts into that JSON; agent-share does the rest (stats, mode projection, redaction, re-scan, publish).

```
agent-share publish --normalized codex-session.json --mode brief
codex-to-agentshare <rollout.jsonl> | agent-share export - --normalized -o out.json
```

## Why this might be worth it
- The only public contract is the schema, which is already versioned (`SCHEMA_VERSION`) and now has documented evolution rules (`src/schema.ts`, `tests/fixtures/shares/README.md`). No plugin API, no code loaded into our process, no new compatibility promise beyond what shares already need.
- Complements (does not depend on) the harness-registry refactor, which makes in-tree/fork support easy. This is the "no fork needed" route.

## Needs a product decision first (do not start without one)
- Do we want to be a platform at all? Third-party converters means bug reports and "why does my Codex share look wrong" questions land here. The user explicitly does not want to maintain other harnesses.
- Is `agentshare/2` a public interface from now on? Today the project treats its own formats as free to break (private tool). Documenting it for external authors reverses that, or at least needs an explicit "unstable, pin a version" statement.
- Where does it stop? `browse`/`list`/`--current` have no discovery for external sessions, so this would be file-in only. Is that acceptable, or does it push people to want discovery hooks (which is the plugin system we decided against)?

## Needs investigation
- Trust and validation: the input is untrusted JSON. The pipeline must validate shape, bound sizes, and treat every string as potentially secret-bearing. Invariants adapters uphold today (e.g. never truncate text before redaction, ass-7x3c; `dropped` counts; `authored` on prompts for `prompts` mode) become the converter author's responsibility; decide what we check, what we refuse, and whether `prompts`/`brief` modes are allowed for externally-normalized sessions at all (`promptsUnavailableReason` exists because a harness's "user" text may not be what the user typed).
- Cost/usage fields: stats rely on adapter-provided usage and `costSource`; what happens with a converter that omits them.
- Does the share/report mark the session as "converted externally" so a reader knows the provenance and that we did not verify the conversion? Does the viewer label an unknown `harness.name` acceptably (it falls back to the raw name today)?
- Cheaper alternative: just document the schema + fixtures and let people fork; compare real demand before building anything.
- Check how other tools do this (e.g. a stdin/JSON contract vs. a plugin system) and whether `agentshare/2` is stable enough to freeze.

## Done when
A decision is recorded (build / don't build / only document), and if build: a scoped follow-up ticket with the validation rules above.

