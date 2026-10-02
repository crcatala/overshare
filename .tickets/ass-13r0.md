---
id: ass-13r0
status: open
deps: []
links: [ass-azwt, ass-iugy, ass-5qv5, ass-8w1o]
created: 2026-10-02T19:40:50Z
type: feature
priority: 2
assignee: cc-vps
tags: [redaction, security, config]
---
# redact: machine-secret harvesting opt-in per source, with transparency and docs

Part of the redaction-hardening work from the ass-azwt review. Needs a short product decision on the defaults (proposed below); the user wants this explicit and clearly documented.

## Problem
Today every publish silently harvests exact secret values from the machine (`collectKnownSecrets`, `src/redact/known-values.ts`, called from `prepareShare` in `src/pipeline.ts:71`): secret-looking env vars; JSON credential files for pi, Claude and Codex (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`); `~/.config/gh/hosts.yml`; `~/.npmrc`; `~/.netrc`; the session project's `.env*` files; and it spawns `gh auth token`. Users are not told this happens, there is no switch for it, and the sources are not listed anywhere user-visible. Many users will not expect a share tool to read their credential files or run `gh auth token`.

## Why (rationale for the decision)
- Reading these values is **valuable**: exact-match replacement is the only redaction layer that catches secrets with no recognizable format (custom internal keys, short passwords, anything the entropy/pattern layers skip: `looksLikeSecret` ignores values < 20 chars and word-heavy ones). Agent transcripts are full of `cat .env` / `printenv` output.
- Reading them is also **surprising and increases blast radius** if the code has a leak bug (see the wrapper ticket).
- So: do **not** turn the layer off wholesale (that would make a real leak more likely), and do not leave the surprising sources on silently. Split by how surprising each source is, make the sensitive ones explicit opt-in, and say what was read.

## Proposed defaults (confirm before implementing)
- **On by default** (already in the process, and the session very likely touched them): secret-looking env vars; the session project's `.env*` files.
- **Off by default, opt-in via global config**: credential JSON files (pi/Claude/Codex), `gh hosts.yml`, `~/.npmrc`, `~/.netrc`, and the `gh auth token` spawn. Config shape is open (e.g. `redact.knownSources: { env, projectEnv, credentialFiles, ghToken }` in `src/config.ts`, one boolean per source, or a list). Choose the simplest.
- Explicit user-declared secrets keep working and stay the recommended safe path: `--secrets-file` (`extraKnownSecrets`) and `redact.denylist`.
- Per project convention (private tool, no compat shims): change defaults directly, bump the schema version if config/report shapes change.

## Transparency
- The publish report (CLI and browse dialog) states which known-value sources were consulted and how many values each contributed (counts and labels only, never values), e.g. `Known values: env (4), project .env (2); not read: credential files, gh token (disabled)`.
- README/docs section "What this tool reads and why": lists every source, which are on by default, what opting in means (values live in process memory during a publish, never written to disk or printed), and the tradeoff. State plainly that **secrets with no recognizable format can still leak when sources are off**: the pattern/entropy layers and the confirmation tier (`ass-iugy`) only see what a pattern matched, so an unformatted secret that was not harvested is invisible to every layer. Recommend `--secrets-file` / `redact.denylist` for known sensitive values.

## Acceptance
- With default config, known-secret collection opens no credential file, `~/.npmrc`, `~/.netrc` or `hosts.yml` and makes no `gh auth token` call (tests inject spies for fs reads and for the collector's `execFileSync`, and assert zero secret-harvesting calls). Scope is the collector only: the `gh` commands the gist publisher legitimately runs (`gh auth status`, `gh gist create`, `gh api`; `src/publish/gist.ts`) are unaffected. Env + project `.env*` still contribute values.
- Enabling each opt-in source in config makes exactly that source contribute values (test per source with temp-home fixtures and a fake `gh`).
- The report (human and `--json`) and the browse publish dialog list consulted vs not-consulted sources with counts, with no values.
- Real-pipeline tests with planted fake secrets still prove: a planted `.env` secret and a planted env var are redacted by default; a planted credential-file secret is redacted only when its source is enabled (otherwise it is caught only if some pattern layer would catch it, and the test documents that gap).
- Docs describe the sources, defaults, risks, and how to opt in; `agent-share --help`/config docs mention the setting.
- Final decision on defaults is recorded in a ticket note.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Context
Decision record (2026-10-02): keep machine-secret harvesting as a deliberate tradeoff, but narrow and make the sensitive sources opt-in. Related: wrapper ticket, mask-fragment ticket, middle-tier ticket (`ass-iugy`; it does NOT compensate for lost recall on unformatted secrets, so there is no ordering dependency between the two; see its note), and ass-azwt, which is blocked on this ticket and must be re-assessed afterwards (a smaller default source set may make the cache unnecessary).

