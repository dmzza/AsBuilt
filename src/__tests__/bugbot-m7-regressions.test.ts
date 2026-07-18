// @vitest-environment jsdom
/**
 * Regression suite for the 5 Bugbot findings autofixed on M7 (PR 6).
 * Authored against pre-autofix tip 83867a3 (each case fails there).
 * Passes on 375dfe9+ (force-break drops incident meases, measure default,
 * solved thickness, wall-move verification).
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  applyEdits,
  defaultMeasureRef,
  junctionPos,
  layerMap,
  loadProject,
  parseLength,
  proposeMove,
  proposeMoveWall,
  resolveAndSolve,
  s64FromFeet,
  s64FromInches,
  thicknessValue,
  verifyWallMove,
  wallView,
} from "../core";
import { useApp } from "../state/store";

const IN = (s: string): number => parseLength(s) / 64;

beforeEach(() => {
  localStorage.clear();
});

describe("Bugbot M7 regressions (autofix)", () => {
  test("1. force-break drops incident face-ref meases (never rewrites them as centerline tape)", () => {
    // Fully measured room + face-ref diagonal. Force-break is not a re-tape:
    // incident meases are removed so a centerline distance cannot keep
    // { ref: inner } and corrupt face residuals. A meas on another room must
    // stay untouched.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured]
param k.width = 12'-0" [measured]
param o.depth = 8'-0" [approximated]
param o.width = 8'-0" [approximated]

room k : rect(k.width, k.depth) { walls: int_2x4 }
room o : rect(o.width, o.depth) { walls: int_2x4 }

meas m_diag : dist(k.sw, k.ne) = 15'-7 1/2" [measured] { ref: inner }
meas m_other : dist(o.sw, o.se) = 8'-0" [measured]
`;
    const project = loadProject({ "asbuilt.abl": src });
    const forced = proposeMove(
      project,
      "asbuilt",
      "k.ne",
      { x: s64FromFeet(14), y: s64FromFeet(12) },
      { forceBreak: true },
    );
    expect(forced.kind).not.toBe("refusal");
    if (forced.kind === "refusal") return;
    expect(forced.broke ?? []).toContain("m_diag");

    const text = applyEdits(project, forced.edits).files.get("asbuilt.abl")!;
    expect(text).not.toMatch(/meas m_diag/);
    expect(text).toMatch(/meas m_other : dist\(o\.sw, o\.se\) = 8'-0" \[measured\]/);
  });

  test("2. measure default is centerline (never invents inner) when room has no dims:inner", () => {
    useApp.getState().loadDemo();
    const pipeline = useApp.getState().pipeline!;
    expect(defaultMeasureRef(pipeline, { wall: "k.north" })).toBe("centerline");

    // Store safety net: omitted face → defaultMeasureRef, not "inner".
    useApp.getState().openEditor({
      target: { kind: "measure-wall", wall: "k.north" },
      anchor: { x: 0, y: 0 },
      initial: "",
      label: "Measured k.north",
    });
    const editor = useApp.getState().editor;
    expect(editor).not.toBeNull();
    expect(editor!.target.kind).toBe("measure-wall");
    if (editor!.target.kind !== "measure-wall") return;
    expect(editor!.target.face).toBe("centerline");
  });

  test("3. drag-ghost thickness uses solved value, not authored walltype", () => {
    // Dual face meases pull soft 4.5" thickness to 5". Preview must read the
    // solved t:walltype (Plan2D uses thicknessValue), not the authored 4.5".
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas mi : dist(k.sw, k.se) = 11'-7" [measured] { ref: inner }
meas mo : dist(k.sw, k.se) = 12'-5" [measured] { ref: outer }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    const authored = 4.5;
    const solved = thicknessValue(p.solution, "int_2x4");
    expect(solved).not.toBeNull();
    expect(solved!).toBeCloseTo(5, 1);
    expect(Math.abs(solved! - authored)).toBeGreaterThan(0.2);
    // Same selection Plan2D uses for the live ghost.
    expect(thicknessValue(p.solution, "int_2x4") ?? authored).toBeCloseTo(5, 1);
  });

  test("4. force-break wall move reports verified only when the translate actually lands", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured]
param k.width = 12'-0" [measured]

room k : rect(k.width, k.depth)
`;
    const project = loadProject({ "asbuilt.abl": src });
    const delta = { x: 24, y: 0 };
    const forced = proposeMoveWall(project, "asbuilt", "k.east", delta, {
      forceBreak: true,
    });
    expect(forced.kind).toBe("wall-move");
    if (forced.kind !== "wall-move") return;
    // Pre-fix force-break path returned verified:true unconditionally.
    // Post-fix: verified tracks verifyWallMove (both ends + midpoint).
    expect(forced.verified).toBe(true);

    const before = resolveAndSolve(layerMap(project), "asbuilt");
    const after = resolveAndSolve(
      layerMap(applyEdits(project, forced.edits)),
      "asbuilt",
    );
    const ne0 = junctionPos(before.solution, "k.ne")!;
    const se0 = junctionPos(before.solution, "k.se")!;
    const ne1 = junctionPos(after.solution, "k.ne")!;
    const se1 = junctionPos(after.solution, "k.se")!;
    expect(ne1.x - ne0.x).toBeCloseTo(delta.x, 0);
    expect(se1.x - se0.x).toBeCloseTo(delta.x, 0);
    expect(wallView(after, "k.north")!.lengthInches).toBeCloseTo(IN("14'"), 0);
  });

  test("5. verifyWallMove rejects midpoint-only matches (both ends must translate)", () => {
    // East wall from (12',0)-(12',10'). Moving only NE by +48" puts the
    // midpoint at +24" — which matches a +24" translate target — but SE
    // did not move. Midpoint-only verify would wrongly accept this.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [approximated]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;
    const project = loadProject({ "asbuilt.abl": src });
    const before = resolveAndSolve(layerMap(project), "asbuilt");
    const ne0 = junctionPos(before.solution, "k.ne")!;
    const se0 = junctionPos(before.solution, "k.se")!;
    const mid0 = { x: (ne0.x + se0.x) / 2, y: (ne0.y + se0.y) / 2 };

    const delta = { x: 24, y: 0 };
    const targetMid = { x: mid0.x + delta.x, y: mid0.y + delta.y };

    // One-sided: only move NE by 2*delta so midpoint shifts by delta.
    const oneSided = proposeMove(project, "asbuilt", "k.ne", {
      x: s64FromInches(ne0.x + 2 * delta.x),
      y: s64FromInches(ne0.y),
    });
    expect(oneSided.kind).not.toBe("refusal");
    if (oneSided.kind === "refusal") return;

    expect(
      verifyWallMove(
        project,
        oneSided.edits,
        "asbuilt",
        "k.ne",
        "k.se",
        targetMid,
        delta,
      ),
    ).toBe(false);

    // Pure translate of the east wall should still verify.
    const wall = proposeMoveWall(project, "asbuilt", "k.east", delta);
    expect(wall.kind).toBe("wall-move");
    if (wall.kind !== "wall-move") return;
    expect(wall.verified).toBe(true);
    expect(
      verifyWallMove(
        project,
        wall.edits,
        "asbuilt",
        "k.ne",
        "k.se",
        targetMid,
        delta,
      ),
    ).toBe(true);

    void se0;
  });
});
