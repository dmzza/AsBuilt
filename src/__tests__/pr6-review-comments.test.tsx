// @vitest-environment jsdom
/**
 * Regression suite for the four PR 6 review comments (ESC ghost, T-join
 * unsplit, measure dismiss, measure face draft retention).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../App";
import {
  applyEdits,
  junctionPos,
  layerMap,
  loadProject,
  proposeAddWall,
  proposeDelete,
  proposeSetParam,
  resolveAndSolve,
  s64FromFeet,
  wallView,
} from "../core";
import { useApp } from "../state/store";

const IN = (ft: number): number => ft * 12;

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  localStorage.clear();
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("PR 6 review-comment regressions", () => {
  test("1. Escape during wall drag clears the live ghost preview", async () => {
    render(<App />);
    await act(async () => {
      useApp.getState().loadDemo();
    });
    await act(async () => {
      useApp.getState().previewEdits(() =>
        proposeSetParam(
          useApp.getState().project!,
          useApp.getState().branch,
          "k.width",
          15 * 12 * 64,
          "approximated",
        ),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(useApp.getState().preview).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useApp.getState().preview).toBeNull();
  });

  test("2. deleting a T-join stem unsplits the host (core)", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [approximated]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth) { walls: int_2x4 }
`;
    const project0 = loadProject({ "asbuilt.abl": src });
    const add = proposeAddWall(project0, "asbuilt", {
      a: { onWall: "k.south", x: s64FromFeet(6), y: 0 },
      b: { x: s64FromFeet(6), y: s64FromFeet(-4) },
      wallType: "int_2x4",
      axis: "v",
    });
    const split = applyEdits(project0, add.edits);
    const next = applyEdits(split, proposeDelete(split, "asbuilt", add.wall));
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(junctionPos(p.solution, "k.south.j")).toBeNull();
    expect(wallView(p, "k.south.b")).toBeNull();
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(12), 1);
  });

  test("3. Escape and outside click dismiss the measure panel", async () => {
    render(<App />);
    await act(async () => {
      useApp.getState().loadDemo();
      useApp.getState().openEditor({
        target: { kind: "measure-wall", wall: "k.north", face: "centerline" },
        anchor: { x: 40, y: 40 },
        initial: "",
        label: "Measured k.north",
      });
      useApp.getState().setMeasurePending("k.ne");
    });
    expect(useApp.getState().editor).not.toBeNull();
    expect(useApp.getState().measurePending).toBe("k.ne");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape", bubbles: true });
    });
    expect(useApp.getState().editor).toBeNull();
    expect(useApp.getState().measurePending).toBeNull();

    await act(async () => {
      useApp.getState().openEditor({
        target: { kind: "measure-wall", wall: "k.north", face: "inner" },
        anchor: { x: 40, y: 40 },
        initial: "",
        label: "Measured k.north",
      });
    });
    expect(screen.getByPlaceholderText(/11'-8/)).toBeTruthy();

    await act(async () => {
      fireEvent.pointerDown(document.body, { bubbles: true });
    });
    expect(useApp.getState().editor).toBeNull();
  });

  test("4. switching measure face keeps the typed draft and refreshes ghost", async () => {
    render(<App />);
    await act(async () => {
      useApp.getState().loadDemo();
      useApp.getState().openEditor({
        target: { kind: "measure-wall", wall: "k.north", face: "inner" },
        anchor: { x: 40, y: 40 },
        initial: "",
        label: "Measured k.north",
      });
    });
    const input = screen.getByPlaceholderText(/11'-8/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: `11'-6"` } });
    });
    expect(input.value).toBe(`11'-6"`);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "outer" }));
    });
    expect(useApp.getState().editor?.target).toMatchObject({
      kind: "measure-wall",
      face: "outer",
    });
    expect(input.value).toBe(`11'-6"`);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(useApp.getState().preview).not.toBeNull();
  });
});
