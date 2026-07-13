// @vitest-environment jsdom
/**
 * Regression suite for the 6 Bugbot findings on M2–M3.
 * Authored against pre-autofix tip 7806617 (each case fails there).
 * Should pass on the tip that includes autofix + follow-up fixes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../App";
import {
  applyEdits,
  layerMap,
  loadProject,
  openingViews,
  parseLength,
  proposeDelete,
  resolveAndSolve,
} from "../core";
import { DEMO_FILES } from "../demo";
import { useApp } from "../state/store";
import { disposeGroup } from "../ui3d/View3D";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubSvgRect(svg: Element): void {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
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
}

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

describe("Bugbot M2–M3 regressions", () => {
  test("1. opening and fixture delete are allowed", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useApp.getState().select("win1");
      useApp.getState().deleteSelection();
    });
    expect(useApp.getState().project!.files.get("asbuilt.abl")!).not.toContain("window win1");
    expect(useApp.getState().toast?.kind).not.toBe("info");

    await act(async () => {
      useApp.getState().select("fridge");
      useApp.getState().deleteSelection();
    });
    expect(useApp.getState().project!.files.get("asbuilt.abl")!).not.toContain("fixture fridge");
  });

  test("2. undo/redo clears stale measure UI (editor + measurePending)", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useApp.getState().setParam("k.width", parseLength(`11'-8"`), "approximated");
    });
    expect(useApp.getState().past.length).toBeGreaterThan(0);

    await act(async () => {
      useApp.getState().openEditor({
        target: { kind: "measure-wall", wall: "k.north" },
        anchor: { x: 10, y: 10 },
        initial: "",
        label: "Measured k.north",
      });
      useApp.getState().setMeasurePending("k.ne");
    });
    expect(useApp.getState().editor).not.toBeNull();
    expect(useApp.getState().measurePending).toBe("k.ne");

    await act(async () => {
      useApp.getState().undo();
    });
    expect(useApp.getState().editor).toBeNull();
    expect(useApp.getState().measurePending).toBeNull();

    await act(async () => {
      useApp.getState().openEditor({
        target: { kind: "param", name: "k.depth", prov: "measured" },
        anchor: { x: 10, y: 10 },
        initial: "",
        label: "k.depth",
      });
      useApp.getState().setMeasurePending("k.sw");
      useApp.getState().redo();
    });
    expect(useApp.getState().editor).toBeNull();
    expect(useApp.getState().measurePending).toBeNull();
  });

  test("3. click-select on fixture/opening does not move geometry or pollute undo", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      useApp.getState().setTool("select");
      useApp.getState().loadDemo();
    });

    const before = useApp.getState().project!.files.get("asbuilt.abl")!;
    const pastBefore = useApp.getState().past.length;
    const svg = container.querySelector("svg");
    const fridge = container.querySelector('[data-key="fridge"]');
    const win = container.querySelector('[data-key="win1"]');
    expect(svg && fridge && win).toBeTruthy();
    stubSvgRect(svg!);

    // Separate acts so pointerdown's setDrag commits before pointerup reads it.
    await act(async () => {
      fireEvent.pointerDown(fridge!, { clientX: 420, clientY: 310, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(svg!, { clientX: 421, clientY: 310, pointerId: 1 });
    });
    expect(useApp.getState().selection).toBe("fridge");
    expect(useApp.getState().project!.files.get("asbuilt.abl")!).toBe(before);
    expect(useApp.getState().past.length).toBe(pastBefore);

    await act(async () => {
      fireEvent.pointerDown(win!, { clientX: 200, clientY: 80, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(svg!, { clientX: 202, clientY: 81, pointerId: 1 });
    });
    expect(useApp.getState().selection).toBe("win1");
    expect(useApp.getState().project!.files.get("asbuilt.abl")!).toBe(before);
    expect(useApp.getState().past.length).toBe(pastBefore);
  });

  test("4. demo reload signals views to refit (sceneEpoch advances)", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const state0 = useApp.getState() as { sceneEpoch?: number };
    expect(typeof state0.sceneEpoch).toBe("number");

    const epoch0 = state0.sceneEpoch as number;
    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect((useApp.getState() as { sceneEpoch: number }).sceneEpoch).toBe(epoch0 + 1);

    await act(async () => {
      useApp.getState().loadDemo();
    });
    expect((useApp.getState() as { sceneEpoch: number }).sceneEpoch).toBe(epoch0 + 2);
  });

  test("5. shared materials are disposed once per unique material", () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const dispose = vi.spyOn(shared, "dispose");
    const group = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared));
    }
    disposeGroup(group);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("6. deleting a wall also removes openings hosted on it", () => {
    const project = loadProject(DEMO_FILES);
    expect(project.files.get("asbuilt.abl")!).toContain("window win1");
    expect(project.files.get("asbuilt.abl")!).toContain("wall dl.north");

    const next = applyEdits(project, proposeDelete(project, "asbuilt", "dl.north"));
    const text = next.files.get("asbuilt.abl")!;
    expect(text).not.toMatch(/wall dl\.north \{/);
    expect(text).not.toMatch(/window win1 \{/);

    const pipeline = resolveAndSolve(layerMap(next), "asbuilt");
    expect(openingViews(pipeline).some((o) => o.key === "win1")).toBe(false);
    expect(pipeline.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(JSON.stringify(pipeline)).not.toMatch(/unknown wall "dl\.north"/);
  });
});
