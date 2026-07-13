// @vitest-environment jsdom
/**
 * Regression suite for the 3 Bugbot findings autofixed on M4–M6 (PR 4).
 * Authored against pre-autofix tip 391fe50 (each case fails there).
 * Passes on dbc38a6+ (timer cancel + level/preview clears).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proposeSetParam } from "../core";
import { useApp } from "../state/store";

beforeEach(() => {
  localStorage.clear();
  useApp.getState().loadDemo();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Bugbot M4–M6 regressions (autofix)", () => {
  test("1. runEdits/setBranch/undo/redo cancel a pending preview timer", () => {
    vi.useFakeTimers();
    const propose = (): ReturnType<typeof proposeSetParam> => {
      const { project, branch } = useApp.getState();
      return proposeSetParam(project!, branch, "k.width", 15 * 12 * 64, "approximated");
    };

    // Pending debounce must not resurrect preview after a commit.
    useApp.getState().previewEdits(propose);
    expect(useApp.getState().preview).toBeNull();
    useApp.getState().setParam("k.width", 12 * 12 * 64, "approximated");
    vi.advanceTimersByTime(200);
    expect(useApp.getState().preview).toBeNull();

    // Same for branch switch.
    useApp.getState().previewEdits(propose);
    useApp.getState().setBranch("galley");
    vi.advanceTimersByTime(200);
    expect(useApp.getState().preview).toBeNull();

    // Undo/redo also cancel — seed history, schedule preview, then undo.
    useApp.getState().setBranch("asbuilt");
    useApp.getState().setParam("k.width", 11 * 12 * 64, "approximated");
    expect(useApp.getState().past.length).toBeGreaterThan(0);
    useApp.getState().previewEdits(propose);
    useApp.getState().undo();
    vi.advanceTimersByTime(200);
    expect(useApp.getState().preview).toBeNull();

    useApp.getState().previewEdits(propose);
    useApp.getState().redo();
    vi.advanceTimersByTime(200);
    expect(useApp.getState().preview).toBeNull();
  });

  test("2. setLevel clears hover preview and highlight", () => {
    vi.useFakeTimers();
    useApp.getState().previewEdits(() =>
      proposeSetParam(
        useApp.getState().project!,
        useApp.getState().branch,
        "k.width",
        15 * 12 * 64,
        "approximated",
      ),
    );
    vi.advanceTimersByTime(200);
    expect(useApp.getState().preview).not.toBeNull();

    useApp.getState().setHighlight(["k.north", "k.sw"]);
    expect(useApp.getState().highlight).toEqual(["k.north", "k.sw"]);

    useApp.getState().setLevel("up");
    expect(useApp.getState().level).toBe("up");
    expect(useApp.getState().preview).toBeNull();
    expect(useApp.getState().highlight).toEqual([]);
  });

  test("3. setBranch resets stale level so the 2D sheet is not filtered empty", () => {
    useApp.getState().setLevel("up");
    expect(useApp.getState().level).toBe("up");

    useApp.getState().setBranch("galley");
    expect(useApp.getState().branch).toBe("galley");
    expect(useApp.getState().level).toBeNull();
  });
});
