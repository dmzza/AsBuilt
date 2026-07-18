# AsBuilt agent instructions

## Fixes that change production `src/` need a regression test

When you fix a bug (Bugbot Autofix, Cloud Agent, or local agent) by changing production code under `src/`:

1. **In the same change**, add or update a Vitest file that would have **failed before** the fix and **passes after**.
2. Put it next to the code or in the colocated suites:
   - `src/core/__tests__/`
   - `src/ui/**/__tests__/` / `src/__tests__/`
   - Prefer extending `src/__tests__/bugbot-*-regressions.test.ts(x)` for a batch of related Bugbot findings.
3. Filename must match Vitest include: `src/**/*.test.ts` or `src/**/*.test.tsx`.
4. Assert the fixed behavior directly — not merely that the suite still runs.
5. Run `npm test` and keep it green before committing or pushing.

Do not ship production-only fix commits. A pre-commit hook will reject staged `src/` production edits that lack a staged matching test file.
