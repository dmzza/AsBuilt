// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../App";
import { useApp } from "../state/store";

// jsdom lacks ResizeObserver and pointer capture
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("app smoke (jsdom)", () => {
  test("boots the demo, renders walls, labels, audit; branch switch re-renders", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    // demo loaded into the store
    const state = useApp.getState();
    expect(state.project).not.toBeNull();
    expect(state.pipeline).not.toBeNull();
    expect(state.pipelineError).toBeNull();

    // walls rendered as thick square-cap lines (L-room 6 + kitchen 4)
    const walls = container.querySelectorAll('line[stroke-linecap="square"]');
    expect(walls.length).toBe(10);

    // space label and provenance-styled dimension text present
    expect(container.textContent).toContain("dining");
    expect(container.textContent).toContain(`(12'-0")`); // approximated south, parenthesized
    expect(container.textContent).toContain("to measure"); // audit badge

    // switch to the concept branch through the store (same path the UI uses)
    await act(async () => {
      useApp.getState().setBranch("galley");
    });
    expect(useApp.getState().pipeline).not.toBeNull();
    // concept's designed kitchen width appears
    expect(container.textContent).toContain(`9'-6"`);

    // live inheritance end-to-end in the UI: drag the kitchen corner in the
    // concept (store path), confirm a set-override lands in the concept file
    await act(async () => {
      useApp.getState().dragJunction("k.ne", { x: (24 + 8) * 768, y: 10 * 768 });
    });
    const galley = useApp.getState().project!.files.get("concepts/galley.abl")!;
    expect(galley).toContain(`set k.width = 8'-0" [designed]`);

    // and the as-built is untouched
    await act(async () => {
      useApp.getState().setBranch("asbuilt");
    });
    expect(container.textContent).toContain(`(11'-6")`);
  });

  test("wall tool store path: placing two points appends junctions + wall", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      const s = useApp.getState();
      s.setTool("wall");
      s.placeWallPoint({ x: 0, y: 20 * 768 });
      s.placeWallPoint({ x: 8 * 768, y: 20 * 768 }, "h");
    });
    const state = useApp.getState();
    expect(state.pipelineError).toBeNull();
    const asbuilt = state.project!.files.get("asbuilt.abl")!;
    expect(asbuilt).toContain("wall w1 { from: j1, to: j2, type:");
    expect(asbuilt).toContain("axis w1 h");
    // chaining: pending start is now the end junction
    expect(state.pendingStart).toEqual({ existing: "j2" });
  });
});
