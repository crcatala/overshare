# Redaction

Everything below runs on your machine before anything is uploaded. The [share mode](sharing.md#share-modes)
is applied first, so detail a mode omits is never redacted, scanned or published.

## Layers

In order (see `src/redact/`):

1. **Structural drop** — never exported: Claude Code `attachment` entries (CLAUDE.md,
   environment, credential org, reminders…), `<system-reminder>` blocks, meta/skill
   bodies, sidechains, system prompts and tool schemas, thinking signatures, image data.
   The report lists what was dropped.
2. **Known local values** — exact values of secret-looking env vars
   (`*KEY*|*TOKEN*|*SECRET*|*PASSWORD*…`) and the session project's `.env*` files, plus anything
   you opt in to or declare (see [What this tool reads and why](#what-this-tool-reads-and-why)).
   Replaced with `[REDACTED:<NAME>]`. Catches secrets in any format.
3. **Patterns** — [`@sanity-labs/secret-scan`](https://github.com/sanity-labs/secret-scan)
   (~1,100 TruffleHog-derived rules). Prefix-anchored rules (GitHub, Anthropic, OpenAI,
   AWS, Stripe, Slack, JWT, private keys, connection strings…) are trusted; generic
   keyword rules must also look random (entropy, mixed letters/digits, not a hash/UUID,
   not a fragment of a longer token). Plus own rules: `password=`-style assignments
   (including `psw` and `_pw` names), URL credentials, auth headers (`Authorization`, `X-Api-Key`,
   `Private-Token`, …), `curl -u user:password`, sensitive JSON keys, age secret keys, PEM blocks.
   Documentation examples (`…EXAMPLE`, sequential runs) are ignored.

   Two parts are hand-written rather than taken from that library (`src/redact/token-formats.ts`):
   a table of about 60 provider token formats recognised by their own prefix when printed bare
   (GitLab, Vercel, Supabase, Neon, Notion, OpenRouter, Perplexity, Google API keys, Slack `xapp-`, …),
   and an AWS secret access key found within a few lines of its access key id, whatever the
   variable is called. Lengths in the table are lower bounds, a body must look random, and
   prefixes short enough to occur in ordinary text (`re_`, `rnd_`, `SK…`) are reported at medium
   confidence. Values in an auth header or `curl -u` get a lower randomness bar than values in
   free text, since the position already says "credential", but identifiers (`csrfTokenValue`)
   and readable words are still left alone.
4. **Paths/PII** — home directory → `~` (also path slugs like `-home-<user>-…`),
   username → `[user]`, emails → `[email]` (no-reply/example addresses kept). Repo and
   project names are kept. Hostname redaction is opt-in.
5. **Final re-scan** of the exact payload bytes: any known value, high-confidence
   pattern or home path still present **blocks publishing**. As a backstop (never the guard against a secret cut in two
   before redaction) it also looks for a long, random-looking prefix or suffix of a known value (**blocks**) or of a secret a
   pattern redacted (**needs confirmation**); ordinary text a value starts or ends with, like `postgres://user:` or a host name, never counts.

## Report status

`overshare report` (and every `export`/`publish`) ends with one of:

- **CLEAN** (exit 0) — no secrets found; `publish --yes` publishes without prompting.
- **NEEDS REVIEW** (exit 2) — secrets were redacted; the report lists each finding by rule and location.
  Publishing requires an interactive "y" or `--yes --allow-findings`.
- **NEEDS CONFIRMATION** (exit 2) — see [Suspicious values](#suspicious-values). Publishing requires an interactive "y" to a
  question that says so, or `--yes --allow-suspicious`.
- **BLOCKED** (exit 3) — the re-scan found something; publishing is refused.

## Suspicious values

The final re-scan blocks on high-confidence matches (known values, prefix-anchored formats like `ghp_`/`sk-ant-`, private keys,
URL credentials, auth headers). It also looks for **medium-confidence** matches (`password=…`-style assignments, generic
keyword rules that look random) in the exact outgoing bytes. The redactor already replaces every medium match in the text it
walks, so what the re-scan can still find sits where the redactor does not look: object keys, and fields outside the
conversation text. Those are reported as **suspicious**: they may be secrets, they are still in the payload, and you decide.

- The report (terminal, `--json`, browse dialog) lists each one by rule, length and **location** (`turn 3 · Bash · input (object key)`,
  turn numbers as in `overshare browse`), the **line numbers** of the transcript file where the value is (`… · line 42`; up to five,
  then `(+N more)`; a hit in a Claude Code subagent transcript is labelled `subagent-file-N`, numbered in file-name order, never by name), plus the transcript file to look at. Never the
  value, a fragment or a hash. Blocked re-scan issues carry the same location and lines, in the terminal and in the browse dialog.
  The lines are found by looking the value up in the source file, not read off the payload, so they never reach the upload; a value
  that only exists after a transformation (not verbatim in the file) is reported by turn and step alone.
- `publish --yes` stops with exit 2 and does not publish; `--allow-findings` does not cover it either, because those secrets are
  redacted and these are not. After inspecting the values, pass `--allow-suspicious`, or add a value that is fine to
  `redact.allowlist` so it is not reported again.
- In `overshare browse`, a payload with suspicious values gets an extra screen before the final confirmation, needing an explicit
  `c`; enter never continues, and nothing is sent before the final `y`.
- Expect this to be rare: on 486 of the author's local sessions it fired on none. Honest limit: it only surfaces what a pattern
  layer matched. A secret with **no recognizable format** matches nothing, so no layer reports it; that is what the known-value
  sources are for, and this tier does not make up for turning them off.

## What reports never show

Findings and final re-scan issues (terminal, `--json` and the browse dialog) show rules, locations,
counts and a length, never a secret value, a fragment of one, or the text around a finding: an
unredacted secret next to a caught one would otherwise be printed into your terminal and CI logs.
Names taken from the data (env/JSON key names, tool names) appear only if they look like plain
identifiers, otherwise as `secret`, `key` or `tool`. The same check applies to the session id, model ids
and the name of a project `.env` file. Tool call ids and response ids that the transcript supplies
go through the exact-value and secret-pattern rules before they are uploaded (not the email and path
rules, which could mangle an id); a secret in one that no pattern recognises is only caught by the final re-scan.

## What this tool reads and why

Exact-value replacement is the only layer that catches a secret with no recognizable format
(a custom internal key, a short password). To do that, `report`, `export`, `publish` and the
browse publish dialog collect secret values from your machine at the start of each run. They
live in process memory for that run only: never written to disk, never printed (reports show
source names and counts, never values), and held in a type that refuses to be stringified.

| Source (`redact.knownSources.<name>`) | What is read | Default |
|---|---|---|
| `env` | secret-looking environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`…) | **on** |
| `projectEnv` | the session project's `.env*` files (not `.example`/`.sample`/`.template`) | **on** |
| `credentialFiles` | pi `auth.json`, Claude `.credentials.json`, Codex `auth.json`, `~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.netrc` | off |
| `ghToken` | runs `gh auth token` | off |

`env` and `projectEnv` are on because they are already in the process or in the project the session
worked in, and agent transcripts are full of `printenv` and `cat .env` output. The other two read
credential stores a share tool is not expected to open, so you choose them. Turn them on in the [config](configuration.md):

```json
{ "redact": { "knownSources": { "credentialFiles": true, "ghToken": true } } }
```

Unknown source names and non-boolean values are config errors. Every report lists what was read and
what was not, with counts only, for example
`Known values: env (4), project .env (2); not read: credential files, gh auth token (disabled)`.
The same line is in `report --json` (`knownSources`) and in the browse publish dialog. This
is about the redaction step only: publishing to a gist still runs `gh auth status`,
`gh gist create` and `gh api`.

**The tradeoff.** With a source off, a secret that exists only there and has no recognizable format
can leak: the pattern and entropy layers only see what some rule matched, so an unformatted secret
that was not harvested is invisible to every layer. For values you know are sensitive, declare them
instead of enabling a credential store: `--secrets-file <file>` (exact values, per run) or
`redact.denylist` (literal strings, always).

## Limits

Pattern redaction is best effort: novel formats, secrets split across lines, or
proprietary code in `full` mode can still leak. Review before sharing publicly;
if something leaks, rotate it — deleting the gist does not undo exposure.

Evaluation on the author's 391 local sessions (360 MB): 0 errors, 0 blocked;
`brief` needs review on 14 sessions (11 s total), `full` on 53 (81 s). Real finds
included a full `env` dump with a dozen API keys and an age secret key.
