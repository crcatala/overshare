#!/usr/bin/env bash
# Project-specific checks for scripts/test-package.sh (the release standard's canonical smoke test).
# Sourced with $consumer (the install prefix) and $tmpdir (the smoke test's scratch directory) set.

bin="$consumer/node_modules/.bin"
pkg="$consumer/node_modules/overshare"

# The viewer build, single-file template and agent integrations ship with the CLI.
for f in viewer/dist/s/index.html viewer/dist/standalone.html viewer/dist/s/examples/session.json viewer/dist/s/font-licenses.txt \
  integrations/claude-code/share-session/SKILL.md integrations/pi/overshare.ts LICENSE README.md; do
  test -f "$pkg/$f" || { echo "missing from package: $f" >&2; exit 1; }
done
# Betterleaks' rule table ships with Betterleaks' MIT notice in it.
node -e 'const t = require(process.argv[1]); if (!/^MIT License\n\nCopyright \(c\)/.test(t.license)) process.exit(1)' "$pkg/dist/redact/betterleaks-rules.json" ||
  { echo "dist/redact/betterleaks-rules.json lacks Betterleaks' license" >&2; exit 1; }
# Nothing else ships: every compiled file (or JSON table) has a source file, and only the viewer build's own
# files are under viewer/dist (no source maps, no landing page).
stray=$(cd "$pkg" && find . -type f -not -path './node_modules/*' | sed 's#^\./##' | grep -vxE \
  'package\.json|README\.md|LICENSE|dist/.+\.js|dist/.+\.json|integrations/claude-code/share-session/SKILL\.md|integrations/pi/overshare\.ts|viewer/dist/standalone\.html|viewer/dist/s/index\.html|viewer/dist/s/examples/session\.json|viewer/dist/s/font-licenses\.txt|viewer/dist/s/assets/[A-Za-z0-9_-]+\.(js|css|woff2|svg)' || true)
for f in $(cd "$pkg" && find dist -type f); do
  # The build stamp is written by scripts/build-info.mjs; it has no source file by design.
  [[ $f == dist/build-info.json ]] && continue
  src="src/${f#dist/}"
  # A compiled module has its .ts source; a JSON table it imports is copied as it is.
  [[ $f == *.json ]] || src="${src%.js}.ts"
  test -f "$src" || stray+=$'\n'"$f (no source file)"
done
if [[ -n "${stray//[$'\n']/}" ]]; then
  echo "unexpected files in package:$stray" >&2
  exit 1
fi

# The bundled fonts are OFL-licensed: their licenses ship beside the viewer and inside every HTML export.
for font in 'JetBrains Mono'; do
  grep -q "^== $font ==" "$pkg/viewer/dist/s/font-licenses.txt" || { echo "font-licenses.txt lacks $font" >&2; exit 1; }
done

# End to end from the installed copy: fake sessions → report → single-file HTML export.
fx="$tmpdir/fixtures"
"$bin/overshare" fixtures --out "$fx" --home /home/fixture-user --user fixture-user >/dev/null
session=$(find "$fx/claude/projects" -name '*.jsonl' | head -n 1)
status=0
"$bin/overshare" report "$session" --mode brief --secrets-file "$fx/secrets.env" >/dev/null || status=$?
# 0 = clean, 2 = needs review (the fixtures plant fake secrets); anything else is a failure.
[[ $status -eq 0 || $status -eq 2 ]] || { echo "report exited with $status" >&2; exit 1; }
"$bin/overshare" export "$session" --mode brief --secrets-file "$fx/secrets.env" -q -o "$tmpdir/share.html" \
  2>"$tmpdir/export.log" || { cat "$tmpdir/export.log" >&2; exit 1; }
grep -q 'overshare' "$tmpdir/share.html"
grep -q 'SIL Open Font License' "$tmpdir/share.html" || { echo 'HTML export lacks the font licenses' >&2; exit 1; }
