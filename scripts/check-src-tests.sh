#!/usr/bin/env bash
# Fail if any commit in BASE..HEAD changes production src/ without also
# adding or modifying a test file in that same commit.
#
# Usage:
#   scripts/check-src-tests.sh <base-sha> <head-sha>
#
# Production: anything under src/ that is not a test file.
# Tests: *.test.ts(x), *.spec.ts(x), or any path under __tests__/.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

BASE="$1"
HEAD="$2"

if [[ "$BASE" =~ ^0+$ ]]; then
  echo "check-src-tests: empty base (force-push); skipping."
  exit 0
fi

if ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "check-src-tests: base '$BASE' not found; skipping."
  exit 0
fi

if ! git cat-file -e "${HEAD}^{commit}" 2>/dev/null; then
  echo "check-src-tests: head '$HEAD' not found" >&2
  exit 1
fi

is_test_path() {
  local f="$1"
  case "$f" in
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) return 0 ;;
  esac
  case "$f" in
    */__tests__/*|__tests__/*) return 0 ;;
  esac
  return 1
}

is_prod_src() {
  local f="$1"
  case "$f" in
    src/*) ;;
    *) return 1 ;;
  esac
  if is_test_path "$f"; then
    return 1
  fi
  return 0
}

failed=0

commits=$(git rev-list --reverse "${BASE}..${HEAD}")
for commit in $commits; do
  # Skip merge commits — they usually don't author the change.
  parent_count=$(git rev-list --parents -n 1 "$commit" | awk '{print NF-1}')
  if [[ "$parent_count" -gt 1 ]]; then
    continue
  fi

  prod=0
  tests=0
  prod_list=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if is_prod_src "$f"; then
      prod=1
      prod_list="${prod_list}${f}"$'\n'
    fi
  done < <(git diff-tree --no-commit-id --name-only -r "$commit")

  # Tests must be added/copied/modified/renamed — pure deletes don't count.
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if is_test_path "$f"; then
      tests=1
    fi
  done < <(git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "$commit")

  if [[ "$prod" -eq 1 && "$tests" -eq 0 ]]; then
    failed=1
    subject=$(git log -1 --format='%s' "$commit")
    echo "✗ $commit — changes production src/ with no new/modified test"
    echo "  $subject"
    printf '%s' "$prod_list" | while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      echo "    src:  $f"
    done
    echo "  Add or modify a test in this commit (*.test.ts(x) / *.spec.ts(x) / __tests__/)."
    echo
  fi
done

if [[ "$failed" -ne 0 ]]; then
  echo "Production src/ changes require a new or modified test in the same commit."
  exit 1
fi

echo "check-src-tests: ok (${BASE:0:7}..${HEAD:0:7})"
