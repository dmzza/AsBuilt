# AsBuilt Bugbot rules

## Autofix must ship regression tests

Every Bugbot Autofix (and any commit that resolves a Bugbot finding) must include a regression test that would have failed on the buggy code and passes after the fix.

- Prefer a focused unit/integration test next to the relevant module (`src/core/__tests__/`, `src/ui/**/__tests__/`, or `src/__tests__/`).
- For a batch of related Bugbot findings, one colocated suite is fine (see `src/__tests__/bugbot-m2-m3-regressions.test.tsx`).
- The test must assert the fixed behavior directly — not merely that the suite still runs.
- Run `npm test` and keep it green before proposing or pushing the autofix.

**CI enforces this:** `scripts/check-src-tests.sh` (Test workflow) fails any commit that changes production `src/` without also adding or modifying a test in that same commit. Vitest must still pass.

If an autofix changes production code under `src/` and the PR diff has no new or updated test covering that bug:

- Add a blocking Bug titled "Autofix missing regression test"
- Body: "This Bugbot autofix changes behavior but adds no regression test. Add a test that fails without the fix and passes with it (`npm test`)."

## Review expectations

- Prefer concrete, reproducible bugs over style nits.
- When suggesting a fix, name the assertion the regression test should make.
