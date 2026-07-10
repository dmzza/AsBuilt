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

  test("measure flow via editor: value commit, contradiction, resolution, undo", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    // measure the kitchen north wall (bound to k.width) through the editor
    await act(async () => {
      useApp.getState().openEditor({
        target: { kind: "measure-wall", wall: "k.north" },
        anchor: { x: 100, y: 100 },
        initial: "",
        label: "Measured k.north",
      });
    });
    expect(container.textContent).toContain("Measured k.north");
    let err: string | null = null;
    await act(async () => {
      err = useApp.getState().commitEditor("11 8 1/2");
    });
    expect(err).toBeNull();
    // routed to the param, not a duplicate meas
    const asbuilt = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(asbuilt).toContain(`param k.width = 11'-8 1/2" [measured`);
    expect(asbuilt).not.toContain("meas m1");

    // bad input reports, doesn't apply
    await act(async () => {
      useApp.getState().openEditor({
        target: { kind: "param", name: "k.depth", prov: "measured" },
        anchor: { x: 100, y: 100 },
        initial: "",
        label: "k.depth",
      });
    });
    await act(async () => {
      err = useApp.getState().commitEditor("garbage");
    });
    expect(err).toMatch(/Cannot parse/);

    // diagonal that disagrees -> contradiction card with suspect rows
    await act(async () => {
      useApp.getState().closeEditor();
      useApp.getState().openEditor({
        target: { kind: "measure-pair", a: "k.sw", b: "k.ne" },
        anchor: { x: 100, y: 100 },
        initial: "",
        label: "diag",
      });
    });
    await act(async () => {
      err = useApp.getState().commitEditor("14'");
    });
    expect(err).toBeNull();
    expect(useApp.getState().pipeline!.solution.contradictions.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Measurements disagree");
    expect(container.textContent).toContain("Pick what gives");

    // undo the diagonal -> contradiction clears
    await act(async () => {
      useApp.getState().undo();
    });
    expect(useApp.getState().pipeline!.solution.contradictions).toEqual([]);
    expect(useApp.getState().project!.files.get("asbuilt.abl")!).not.toContain("meas m1");

    // redo brings it back
    await act(async () => {
      useApp.getState().redo();
    });
    expect(useApp.getState().pipeline!.solution.contradictions.length).toBeGreaterThan(0);
  });

  test("M4: masked-correction card, review actions, sheet panel re-parent", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    // correct the base under the concept's override
    await act(async () => {
      useApp.getState().setParam("k.width", 140.5 * 64, "measured"); // 11'-8 1/2"
    });

    // on the concept: review card with both resolutions
    await act(async () => {
      useApp.getState().setBranch("galley");
    });
    expect(container.textContent).toContain("Base corrected under your override");
    expect(container.textContent).toContain(`Keep 9'-6"`);
    expect(container.textContent).toContain(`Adopt 11'-8 1/2"`);
    // parent ghost is on: dashed parent walls render under the concept
    expect(container.querySelectorAll('line[stroke-dasharray="6 4"]').length).toBeGreaterThan(0);

    // keep the design: flag clears, (was ...) updated in the concept file
    await act(async () => {
      useApp.getState().resolveMasked("k.width", "keep");
    });
    expect(container.textContent).not.toContain("Base corrected under your override");
    expect(useApp.getState().project!.files.get("concepts/galley.abl")!).toContain(
      `(was 11'-8 1/2")`,
    );

    // sheet panel on the root: no parent select, just the root note
    await act(async () => {
      useApp.getState().setBranch("asbuilt");
    });
    expect(container.textContent).toContain("as-built root");

    // create a sibling concept and re-parent galley under it
    await act(async () => {
      useApp.getState().newConcept("addition");
      useApp.getState().setBranch("galley");
      useApp.getState().reparent("addition");
    });
    expect(useApp.getState().project!.files.get("concepts/galley.abl")!).toContain(
      "layer galley : addition",
    );
    expect(useApp.getState().pipelineError).toBeNull();

    // cycle rejected with a toast, file untouched
    await act(async () => {
      useApp.getState().setBranch("addition");
      useApp.getState().reparent("galley");
    });
    expect(useApp.getState().toast?.message).toMatch(/cycle/);
    expect(useApp.getState().project!.files.get("concepts/addition.abl")!).toContain(
      "layer addition : asbuilt",
    );
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

  test("clicking a fixture (offset from center, no drag) does not move it", async () => {
    const { fireEvent } = await import("@testing-library/react");
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    // Isolate from prior tests' zustand leftovers (boot does not clear selection/tool).
    await act(async () => {
      useApp.getState().setTool("select");
      useApp.getState().loadDemo();
    });

    const before = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(before).toMatch(/fixture fridge \{[^}]*at: ~\(26'-0", 8'-0"\)/);

    const svg = container.querySelector("svg.plan");
    const g = container.querySelector('[data-key="fridge"]');
    expect(svg).not.toBeNull();
    expect(g).not.toBeNull();

    vi.spyOn(svg!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
      toJSON() {
        return {};
      },
    });

    await act(async () => {
      fireEvent.pointerDown(g!, { clientX: 420, clientY: 310, pointerId: 1 });
    });
    // Realistic trackpad click: a few pointermoves under the arm threshold.
    await act(async () => {
      fireEvent.pointerMove(svg!, { clientX: 424, clientY: 313, pointerId: 1 });
      fireEvent.pointerMove(svg!, { clientX: 427, clientY: 314, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(svg!, { clientX: 428, clientY: 314, pointerId: 1 });
    });

    expect(useApp.getState().selection).toBe("fridge");
    const after = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(after).toMatch(/fixture fridge \{[^}]*at: ~\(26'-0", 8'-0"\)/);
    expect(after).toBe(before);

    // Contrast: a real drag (pointermove past CLICK_PX) must still move the fixture.
    await act(async () => {
      fireEvent.pointerDown(g!, { clientX: 420, clientY: 310, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(svg!, { clientX: 520, clientY: 310, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(svg!, { clientX: 520, clientY: 310, pointerId: 1 });
    });
    const dragged = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(dragged).not.toBe(before);
    expect(dragged).toMatch(/fixture fridge \{/);
  });

  test("clicking a window (offset along wall, no drag) does not rewrite its offset", async () => {
    const { fireEvent } = await import("@testing-library/react");
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      useApp.getState().setTool("select");
      useApp.getState().loadDemo();
    });

    const before = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(before).toContain(`window win1 { in: dl.north, at: 4'-0" from dl.nw`);

    const svg = container.querySelector("svg.plan");
    const g = container.querySelector('[data-key="win1"]');
    expect(svg).not.toBeNull();
    expect(g).not.toBeNull();
    vi.spyOn(svg!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
      toJSON() {
        return {};
      },
    });

    await act(async () => {
      fireEvent.pointerDown(g!, { clientX: 200, clientY: 80, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(svg!, { clientX: 202, clientY: 81, pointerId: 1 });
    });

    expect(useApp.getState().selection).toBe("win1");
    const after = useApp.getState().project!.files.get("asbuilt.abl")!;
    expect(after).toContain(`window win1 { in: dl.north, at: 4'-0" from dl.nw`);
    expect(after).toBe(before);
  });

  test("loadDemo bumps sceneEpoch so views remount/refit", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    const epoch0 = useApp.getState().sceneEpoch;
    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect(useApp.getState().sceneEpoch).toBe(epoch0 + 1);
    // key={sceneEpoch} remounts Plan2D — empty-state shouldn't stick after Demo.
    expect(container.querySelector("svg.plan")).not.toBeNull();
    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect(useApp.getState().sceneEpoch).toBe(epoch0 + 2);
    expect(container.querySelector("svg.plan")).not.toBeNull();
  });

  test("Demo in split view keeps exactly one 2D and one 3D pane", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      useApp.getState().setViewMode("split");
      useApp.getState().loadDemo();
    });

    expect(container.querySelectorAll(".plan-wrap")).toHaveLength(1);
    expect(container.querySelectorAll(".view3d")).toHaveLength(1);
    expect(container.querySelectorAll("svg.plan")).toHaveLength(1);

    // Each Demo bump must remount without duplicating panes (duplicate sibling
    // keys on Plan2D/View3D previously left extra 2D views in split mode).
    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect(container.querySelectorAll(".plan-wrap")).toHaveLength(1);
    expect(container.querySelectorAll(".view3d")).toHaveLength(1);
    expect(container.querySelectorAll("svg.plan")).toHaveLength(1);

    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect(container.querySelectorAll(".plan-wrap")).toHaveLength(1);
    expect(container.querySelectorAll(".view3d")).toHaveLength(1);
    expect(container.querySelectorAll("svg.plan")).toHaveLength(1);
  });
});
