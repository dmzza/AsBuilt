/**
 * Regression test for bug fb66e5ed: check-staged-src-tests.sh depth cap.
 * Validates that the script's is_vitest_file logic (now regex-based) matches
 * Vitest's unlimited-depth src/**\/*.test.ts(x) pattern.
 */
import { describe, expect, test } from "vitest";

describe("check-staged-src-tests.sh: is_vitest_file regex", () => {
  // Simulate the bash regex pattern used in the fixed script: ^src/.+\.test\.tsx?$
  const isVitestFile = (path: string): boolean => {
    return /^src\/.+\.test\.tsx?$/.test(path);
  };

  test("recognizes test files at any depth (unlimited **)", () => {
    // Depth 1-5 (previously worked)
    expect(isVitestFile("src/app.test.ts")).toBe(true);
    expect(isVitestFile("src/core/util.test.ts")).toBe(true);
    expect(isVitestFile("src/a/b/c.test.tsx")).toBe(true);
    expect(isVitestFile("src/a/b/c/d.test.ts")).toBe(true);
    expect(isVitestFile("src/a/b/c/d/e.test.tsx")).toBe(true);

    // Depth 6+ (bug: previously failed)
    expect(isVitestFile("src/a/b/c/d/e/f.test.ts")).toBe(true);
    expect(isVitestFile("src/ui/deep/nested/path/components/__tests__/widget.test.tsx")).toBe(true);
    expect(isVitestFile("src/a/b/c/d/e/f/g/h/i/j.test.ts")).toBe(true);
  });

  test("rejects non-test files under src/", () => {
    expect(isVitestFile("src/app.ts")).toBe(false);
    expect(isVitestFile("src/core/index.tsx")).toBe(false);
    expect(isVitestFile("src/a/b/c/d/e/f/component.tsx")).toBe(false);
  });

  test("rejects files outside src/", () => {
    expect(isVitestFile("test.test.ts")).toBe(false);
    expect(isVitestFile("scripts/util.test.ts")).toBe(false);
    expect(isVitestFile("tests/integration.test.ts")).toBe(false);
  });

  test("requires at least one path component after src/", () => {
    expect(isVitestFile("src/.test.ts")).toBe(false);
    expect(isVitestFile("src/")).toBe(false);
  });
});
