#!/usr/bin/env bash
# Build the npm tarball and smoke-test the CLI exactly as a consumer receives it:
# install it with production dependencies only, then run it end to end on fake sessions.
set -euo pipefail

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# npm pack runs prepack (a full build), whose output would mix with --json; find the tarball instead.
npm pack --loglevel=error --pack-destination "$tmpdir" >/dev/null
archive=$(find "$tmpdir" -maxdepth 1 -name 'overshare-*.tgz')
consumer="$tmpdir/consumer"
npm install --omit=dev --no-audit --no-fund --prefix "$consumer" "$archive" >/dev/null

bin="$consumer/node_modules/.bin"
pkg="$consumer/node_modules/overshare"
expected=$(node -p 'require("./package.json").version')

# Both command names work and report the packaged version.
test "$("$bin/overshare" --version)" = "$expected"
test "$("$bin/ovs" --version)" = "$expected"
"$bin/overshare" --help >/dev/null

# The viewer build, single-file template and agent integrations ship with the CLI.
for f in viewer/dist/s/index.html viewer/dist/standalone.html viewer/dist/s/examples/session.json viewer/dist/s/font-licenses.txt \
  integrations/claude-code/share-session/SKILL.md integrations/pi/overshare.ts LICENSE README.md; do
  test -f "$pkg/$f" || { echo "missing from package: $f" >&2; exit 1; }
done
# Nothing else ships: every compiled file has a source file, and only the viewer build's own
# files are under viewer/dist (no source maps, no landing page).
stray=$(cd "$pkg" && find . -type f -not -path './node_modules/*' | sed 's#^\./##' | grep -vxE \
  'package\.json|README\.md|LICENSE|dist/.+\.js|integrations/claude-code/share-session/SKILL\.md|integrations/pi/overshare\.ts|viewer/dist/standalone\.html|viewer/dist/s/index\.html|viewer/dist/s/examples/session\.json|viewer/dist/s/font-licenses\.txt|viewer/dist/s/assets/[A-Za-z0-9_-]+\.(js|css|woff2)' || true)
for f in $(cd "$pkg" && find dist -type f); do
  src="src/${f#dist/}"
  test -f "${src%.js}.ts" || stray+=$'\n'"$f (no source file)"
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

echo 'Package smoke test passed.'
