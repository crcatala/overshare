# Betterleaks rules (vendored)

`betterleaks.toml` is Betterleaks' rule file, copied unchanged from the release named in
`upstream.json` (tag, commit, the file's path and its sha256). `LICENSE` is Betterleaks' MIT license
from the same commit. Do not edit either by hand.

`npm run update:betterleaks` converts the rule file into `src/redact/betterleaks-rules.json`, checking
the sha256 first. Only the rules' shapes are taken: their `validate`, `analyze` and `revoke` steps
(which would send a found secret to the provider) are never converted. See
[docs/development.md](../../docs/development.md#betterleaks-rules).
