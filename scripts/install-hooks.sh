#!/bin/sh
# Point git at the committed hooks in .githooks/ so the gitleaks pre-commit
# guard runs. Idempotent; run once per checkout.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true
echo "core.hooksPath -> .githooks (pre-commit secret scan enabled)"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "note: gitleaks is not installed, so the hook will no-op until you install it."
fi
