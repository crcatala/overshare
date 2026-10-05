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

# The viewer build, single-file template and agent integrations ship with the CLI;
# source maps and the landing page do not.
for f in viewer/dist/s/index.html viewer/dist/standalone.html viewer/dist/s/examples/session.json \
  integrations/claude-code/share-session/SKILL.md integrations/pi/overshare.ts LICENSE README.md; do
  test -f "$pkg/$f" || { echo "missing from package: $f" >&2; exit 1; }
done
if find "$pkg" -name '*.map' | grep -q .; then
  echo 'source maps should not be in the package' >&2
  exit 1
fi
test ! -e "$pkg/viewer/dist/index.html" || { echo 'landing page should not be in the package' >&2; exit 1; }

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

echo 'Package smoke test passed.'
