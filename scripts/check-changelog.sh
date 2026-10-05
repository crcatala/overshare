#!/usr/bin/env bash
# Fail a release when CHANGELOG.md has no unreleased user-facing entries.
set -euo pipefail

content=$(awk '/^## \[Unreleased\]/{found=1; next} /^## \[/{exit} found{print}' CHANGELOG.md)
if ! awk '/^### /{section=1; next} section && /^[-*+] /{found=1} END{exit !found}' <<<"$content"; then
  echo 'Error: CHANGELOG.md has no unreleased user-facing entries.' >&2
  echo 'Add a Keep a Changelog section with at least one item, such as "### Added" followed by "- New feature".' >&2
  exit 1
fi

echo 'Changelog has unreleased entries.'
