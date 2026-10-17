#!/bin/sh
# Point git at the committed hooks in .githooks/ so the gitleaks pre-commit
# guard runs. Idempotent; run once per checkout.
#
#   scripts/install-hooks.sh            warn-only when gitleaks is missing
#   scripts/install-hooks.sh --require  strict: a missing gitleaks blocks commits
#
# Round-2 finding: the pre-commit comment documented `--require`, but this script
# ignored every argument, so the strict path silently did nothing — the one
# documented way to turn the scan into a hard failure was a no-op.
set -eu

require=0
for arg in "$@"; do
  case "$arg" in
    --require) require=1 ;;
    -h|--help)
      echo "usage: scripts/install-hooks.sh [--require]"
      exit 0
      ;;
    *)
      echo "install-hooks.sh: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true
echo "core.hooksPath -> .githooks (pre-commit secret scan enabled)"

if [ "$require" -eq 1 ]; then
  # Persisted in this checkout's git config, which is where the hook reads it.
  git config --bool hermes.gitleaksRequire true
  echo "strict mode ON: a missing gitleaks now blocks this checkout's commits"
  echo "(undo: git config --unset hermes.gitleaksRequire)"
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  if [ "$require" -eq 1 ]; then
    echo "WARNING: gitleaks is not installed and strict mode is ON — commits are blocked." >&2
    echo "         install it: https://github.com/gitleaks/gitleaks#installing" >&2
  else
    echo "note: gitleaks is not installed, so the hook will no-op until you install it."
    echo "      run this script with --require to block commits instead."
  fi
fi
