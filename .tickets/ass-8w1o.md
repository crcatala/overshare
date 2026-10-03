---
id: ass-8w1o
status: closed
deps: []
links: [ass-13r0, ass-azwt, ass-iugy, ass-5qv5]
created: 2026-10-02T19:40:50Z
type: task
priority: 2
assignee: cc-vps
tags: [redaction, security]
---
# redact: wrap KnownSecret values so they cannot be printed or serialized, plus leak test

Part of the redaction-hardening work from the ass-azwt review.

## Problem
`collectKnownSecrets` (`src/redact/known-values.ts`) returns `KnownSecret { value, label, source }[]` as plain objects with the raw secret in a plain string field. These objects are passed through `prepareShare` -> `Redactor` -> `rescanPayload` (and, once ass-azwt is considered, possibly held in a cache). Any `console.log(obj)`, `JSON.stringify`, `util.inspect`, error message that interpolates the object, uncaught-exception dump, or debugger/telemetry/crash-report capture prints every secret on the machine. Today this is prevented only by convention ("reports show label + source only").

## Why
The realistic way a tool like this leaks a secret is not an attacker reading process memory (anything running as the user can already read the env and dotfiles); it is an accident: a debug print, a stringified error, a serialized state object. A type that refuses to be printed turns "be careful" into "cannot be done by mistake", for the cost of a small class.

## Design notes
- Make the secret value a wrapper (e.g. `class SecretValue`) holding the string in a **non-enumerable / `#private` field**, exposing an explicit accessor used only by the matcher (`reveal()` or similar). Override `toString()`, `toJSON()`, `[Symbol.toPrimitive]`, and `[util.inspect.custom]` to return `[redacted]` (or `[redacted:<label>]`).
- Callers that need the value today: `Redactor` (replace) and `rescanPayload` (`payload.includes`), plus the allowlist comparison (`allow.has(k.value)`). Keep the number of `reveal()` call sites tiny and greppable; consider a lint rule or a test that greps for them.
- Keep `label` and `source` as plain, printable fields.
- Also check string interpolation of values into error messages across `src/redact/*`, `src/pipeline.ts`, and `src/browse/source.ts`; none should interpolate a value.
- Per project convention: change the type directly, no compat layer. Update tests and fixtures that construct `KnownSecret` literals.

## Context
Decision record (2026-10-02): we keep harvesting machine secrets (narrowed and made opt-in by the harvesting-config ticket) because it is the only layer that catches non-standard-format secrets, so the values must be made hard to leak. Related: mask-fragment ticket, harvesting-config ticket, ass-azwt (a cache would hold these objects, so the wrapper must exist first).

## Acceptance
- `JSON.stringify(secret)`, `String(secret)`, `` `${secret}` ``, `util.inspect(secret)`, `console.log(secret)`, and `console.log({ secrets: [secret] })` never contain the value (test each).
- A leak test runs the real pipeline (`prepareShare`) with planted fake secrets in env / `.env` / credential-file fixtures and **forces failures** (a throwing publisher, a malformed transcript, a rescan block). It then asserts that no thrown error message, `console.*` output, or stderr/stdout capture contains any planted value.
- Only the matcher paths call the accessor; a test or grep check enforces that the call sites stay limited to an expected list.
- `npm test`, `npm run typecheck`, `npm run build` pass.


## Notes

**2026-10-02T22:23:18Z**

2026-10-02 implemented. Design: SecretValue (src/redact/secret-value.ts) keeps the text in a #private field with no accessor at all; the matchers the layers need (isIn, countIn, replaceIn, contains, inSet, equals) live on the class, so no code outside it ever holds the raw string. This is stricter than the ticket's reveal() sketch: there are zero reveal() call sites to audit. toString/toJSON/Symbol.toPrimitive/util.inspect.custom return [redacted]. KnownSecret.value is now a SecretValue; knownSecret(value,label,source) is the only constructor path (collectKnownSecrets, readSecretsFile). label/source stay plain. Tests: tests/secret-leaks.vitest.ts (print-path matrix; encapsulation guard on the prototype surface, constructor sites and matcher call sites; real-pipeline leak tests with secrets planted in env, .env, claude/codex credential files, gh hosts.yml, .npmrc, .netrc, gh auth token via a fake gh, and extraKnownSecrets, forcing a rescan block, malformed transcripts, a failing GistPublisher and a sloppy publisher that dumps everything; plus a CLI e2e for report/blocked/failed-publish/garbage input). Mutation check: making SecretValue stringify to the value fails 15 of the tests. Note: the CLI treats a garbage file as an empty session rather than an error (parsers tolerate torn lines); not changed here.

**2026-10-03T00:57:46Z**

Review fix: the malformed-transcript leak test asserted inside its try/catch (a leak would have been swallowed) and all four inputs threw, so the output-side check never ran. Assertions moved out of the try, two tolerated inputs (valid session + junk/torn line) added, and the test now requires both branches to run. Verified by mutation (printing a planted value on a tolerated input fails it). Follow-up for a TypeError found on the way: ass-3llz.
