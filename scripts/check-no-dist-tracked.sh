#!/usr/bin/env bash
# F.7.5 (ttv-finals): CI guard that fails the build if any dist/ or
# *.tsbuildinfo file gets re-added to the git index.
#
# Why: previous branches accumulated 30+ committed packages/cli/dist/*
# files and assorted tsbuildinfo churn, turning every PR into a noise-
# vs-signal triage exercise. The root .gitignore already covers the
# pattern; this script catches the case where someone bypasses it with
# `git add -f`.
#
# Exit codes:
#   0 — clean
#   1 — at least one matching tracked file detected
set -euo pipefail

# `git ls-files` operates relative to the repo root; this guard is
# repo-wide intentionally so any package adding a dist commit is caught.
matches="$(git ls-files | grep -E '/dist/|\.tsbuildinfo$' || true)"

if [ -n "$matches" ]; then
  echo "✗ dist/ or *.tsbuildinfo files are tracked in git:" >&2
  echo "$matches" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  These are build artefacts and must not live in the repo." >&2
  echo "  Untrack with:  git rm --cached <paths>" >&2
  echo "  Then commit:    git commit -m 'chore(repo): untrack dist/tsbuildinfo files'" >&2
  exit 1
fi

echo "✓ no dist/ or *.tsbuildinfo files tracked in git"
