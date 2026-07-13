#!/usr/bin/env bash
# Reject commits that stage production src/ changes without also staging a
# Vitest file (src/**/*.test.ts or src/**/*.test.tsx).
#
# Usage (pre-commit): scripts/check-staged-src-tests.sh
set -euo pipefail

is_vitest_file() {
  local f="$1"
  case "$f" in
    src/*.test.ts|src/*.test.tsx) return 0 ;;
    src/*/*.test.ts|src/*/*.test.tsx) return 0 ;;
    src/*/*/*.test.ts|src/*/*/*.test.tsx) return 0 ;;
    src/*/*/*/*.test.ts|src/*/*/*/*.test.tsx) return 0 ;;
    src/*/*/*/*/*.test.ts|src/*/*/*/*/*.test.tsx) return 0 ;;
  esac
  return 1
}

is_prod_src() {
  local f="$1"
  case "$f" in
    src/*) ;;
    *) return 1 ;;
  esac
  if is_vitest_file "$f"; then
    return 1
  fi
  return 0
}

prod=0
tests=0
prod_list=""

# Added / copied / modified / renamed only — pure deletes don't satisfy the gate.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if is_prod_src "$f"; then
    prod=1
    prod_list="${prod_list}  $f"$'\n'
  elif is_vitest_file "$f"; then
    tests=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [[ "$prod" -eq 1 && "$tests" -eq 0 ]]; then
  echo "pre-commit: production src/ changes require a staged Vitest file."
  echo "Add or modify src/**/*.test.ts(x) in this commit (see AGENTS.md)."
  echo "Staged production files:"
  printf '%s' "$prod_list"
  exit 1
fi

exit 0
