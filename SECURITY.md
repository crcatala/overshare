# Security Policy

overshare exists to keep secrets out of shared transcripts, so reports about it failing to do that
are taken seriously.

## Supported versions

Only the latest published version receives security fixes. The hosted viewer at
<https://overshare.link/s/> always runs the latest build.

## Reporting a vulnerability

Please **do not** open a public issue, and never include a real secret, credential or transcript.
Use GitHub's [private vulnerability reporting](https://github.com/crcatala/overshare/security/advisories/new)
for this repository, or contact [@crcatala](https://github.com/crcatala) privately, with a
reproduction (fake sessions from `overshare fixtures` are ideal), the impact, and a suggested
mitigation if you have one.

In scope, for example:

- a secret that survives into an uploaded payload despite a matching rule or a known value,
  or that the final re-scan should have blocked;
- a report, log or terminal output that prints a secret value or a fragment of one;
- script execution, remote content loading or UI spoofing in the viewer from a crafted share;
- terminal escape sequences from a transcript reaching your terminal in `overshare browse`.

A secret in a format no rule recognizes is a known limit of pattern matching (see
[docs/redaction.md](docs/redaction.md#limits)); a regular issue with a made-up example of the format is fine.

You should receive an acknowledgement within seven days. Public disclosure will be coordinated after
a fix is available.
