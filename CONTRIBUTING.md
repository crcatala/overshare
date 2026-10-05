# Contributing

Thanks for your interest in overshare.

This is a personally maintained project. Issues are welcome: bug reports, missed secret formats, and
ideas. I am not accepting code contributions or pull requests at this time, and pull requests may be
closed without review.

## Bug reports

Bug reports are welcome. Include the overshare version (`overshare --version`), your operating system,
Node.js version, the agent (Claude Code or pi) and its version, and the command you ran.

**Never attach a real transcript or share file.** Session transcripts hold your code, prompts and
often secrets. Instead:

- paste the output of `overshare report --json` (it lists rules, locations and counts, never secret
  values), or
- reproduce the problem with fake sessions from `overshare fixtures` and attach those.

If redaction missed a secret format, describe the format with a made-up example, never a real value.
If a real secret was published, rotate it first.

## Security issues

Do not report vulnerabilities in a public issue; see [SECURITY.md](SECURITY.md).

## Building from source

Setup, tests and architecture are in [docs/development.md](docs/development.md), for running a
local checkout or maintaining a fork.

## Forks

You are welcome to fork overshare and adapt it, including deploying your own viewer
([docs/self-hosting.md](docs/self-hosting.md)), under the terms of the [MIT License](LICENSE).
