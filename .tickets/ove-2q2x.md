---
id: ove-2q2x
status: open
deps: []
links: []
created: 2026-10-19T16:56:17Z
type: epic
priority: 3
assignee: cc-vps
tags: [redaction, betterleaks]
---
# Betterleaks as the source of secret-shape rules

Use Betterleaks' rule file as the library of secret shapes overshare recognises, so new token formats arrive by syncing a file rather than by writing patterns by hand. Not committed to yet: phase 0 is worth doing on its own, and phases 1–2 are one experiment that decides whether the rest happens.

## Where the shapes come from today

overshare finds secrets three ways: exact copies of the user's own values (env, `.env`), recognisable shapes (`ghp_…`, `sk-ant-…`), and a final re-scan of the exact upload that refuses to publish what slipped through. This epic touches only the second.

- About 1,100 shapes come from `@sanity-labs/secret-scan`, which `src/redact/token-formats.ts` itself calls a frozen snapshot of TruffleHog's detectors: it does not pick up new formats.
- About 60 more are hand-written in `token-formats.ts`, to cover formats that library misses. Betterleaks was the checklist for which providers to add.

So a small rule list is already kept current by hand.

## What Betterleaks offers

Betterleaks is the maintained successor to Gitleaks, by the same people (Gitleaks has had only dependency bumps since v8.30.1 in March 2026). Its rules are one MIT-licensed TOML file, 466 rules as of v2.0.0-rc.2, updated as providers ship new token formats. overshare would take the rule file only and evaluate it with its own code; it never runs the Betterleaks tool.

## How the architecture changes

Little. `findSecretPatterns` already returns `{ rule, start, end, confidence }`, and everything downstream works from that: the redactor, the final re-scan, the report and the share modes. Betterleaks rules come labelled high, medium or low confidence, which maps onto ours.

Added:
- a pinned copy of the rule file (`vendor/betterleaks/`, with its LICENSE and the release it came from);
- a converter that turns it into a rule table JavaScript can use, stripping what does not apply;
- one more detection source in `patterns.ts`, next to secret-scan at first;
- a playbook for syncing with new releases.

Unchanged: how secrets are replaced, the final re-scan, the report, and the rule that no value, fragment or surrounding text is ever printed.

## Phases

Each phase is its own PR, small enough to measure; the epic can stop after any of them.

0. ove-zcms: a measuring tool (`npm run audit:redaction`): before/after across local sessions, by rule name and timing, never values. Useful even without Betterleaks.
1. ove-3b8f: vendor the rule file and the converter, not wired in. No behaviour change.
2. ove-ro4e: detect with Betterleaks' high-confidence rules alongside secret-scan, and measure.
3. ove-byj4: prune hand-written formats Betterleaks covers; decide whether secret-scan stays.
4. ove-mgjr: a playbook for syncing with new releases by hand (decided 2026-10-20; see the ticket).

## Benefits

- New token formats arrive without writing them: the main reason.
- Less detection code of our own to maintain and test.
- Visible changes: a pinned, vendored file makes every sync a reviewable diff, and the audit shows its effect on real sessions.
- Possibly one dependency fewer, if phase 3 shows secret-scan can go.

## Costs and risks

- About 5% of rules (24 of 465 at v2 rc) use regex syntax JavaScript lacks and need mechanical rewriting. Node 22 (our minimum) has no `(?i:…)` modifiers, which adds a little more.
- The rules were written for Go's regex engine, which cannot backtrack catastrophically; JavaScript's can, on unlucky input, and transcripts are untrusted. The existing 32 KB chunking limits the damage. Removing the risk outright means a linear-time engine (re2 or a WASM build) as a dependency. Phase 2 tests for it before anything is decided.
- Most rules carry false-positive filters in Betterleaks' Go expression language, some needing a BPE tokenizer (`tokenRatio`, cl100k). They do not come along. That is why only high-confidence rules are planned: they rarely need filtering, and our own `looksLikeSecret` checks keep that job for the rest.
- About half the rules carry a `validate` step that sends the found secret to the provider's live API. The converter must strip it, and a test must keep it out. Never enable it.
- Results shift a little: some clean sessions become "needs review", and labels change (`[REDACTED:github-v2]` becomes `[REDACTED:github-pat]`). Shares are static files and the allowlist matches values, not rule names, so labels changing is harmless.
- Real work for a gain that builds up over time. Today the major providers are already covered, and the final re-scan backs up the high-confidence ones.

## Betterleaks v1 or v2 (checked 2026-10-19)

The rules barely differ between v1.9.0 (stable, 463 rules) and v2 (`main`, 466 rules, v2.0.0-rc.2 the newest pre-release); v2's large changes are to the tool (CLI, validation and analysis, report format, SDK), not to the rules.

- Regexes: identical for every rule but one (`tableau-personal-access-token.1`, a boundary tweak).
- Keywords and confidence: identical.
- Filters: changed in 161 rules, but only by a rename of the functions they call (`filter.entropy(…)` became `entropy(…)`).
- `secretGroup` was renamed `valueGroup`, with the same meaning.
- v2 adds `analyze` and `revoke` (stripped like `validate`), and restructures a few rules (Cloudflare's key rule split in two, plus `cloudflare-account-id.1` and `nuget-api-key`).

So there is no reason to wait for v2. The converter accepts both shapes, phase 1 pins whichever is the latest stable release when it starts, and moving to v2 later is an ordinary sync.

## Deciding

Do phase 0 regardless: it is small, makes any later change to detection safer, and in PR #73 the same check found two real credentials `main` would have published. Treat phases 1–2 as one experiment: vendor the rules, run them next to secret-scan, and let the audit say whether they catch anything the current setup misses on real sessions. If not, stop there at little cost.

