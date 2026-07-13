import { describe, expect, test } from "vitest";
import {
  applyEdits,
  createConcept,
  layerMap,
  loadProject,
  proposeAddWall,
  proposeDelete,
  proposeSplitWall,
} from "../editkit";
import { resolveAndSolve, wallView } from "../model";
import { parseLayerFile } from "../parser";
import { printLayerFile } from "../printer";
import { junctionPos } from "../solve";
import { parseLength, s64FromFeet, s64FromInches } from "../units";

const IN = (s: string): number => parseLength(s) / 64;

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;

describe("axis statements are authorable", () => {
  test("parse/print round-trip", () => {
    const text = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

junction a ~(0", 0")
junction b ~(8'-0", 0")

wall w1 { from: a, to: b, type: int_2x4 }

axis w1 h
`;
    const parsed = parseLayerFile("a.abl", text);
    expect(printLayerFile(parsed)).toBe(text);
  });

  test("authored axis constrains the wall; tombstoning it relaxes", () => {
    const withAxis = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

junction a ~(0", 0")
junction b ~(8'-0", 3")

wall w1 { from: a, to: b, type: int_2x4 }

axis w1 h
`;
    const layers = new Map([["asbuilt", parseLayerFile("a.abl", withAxis)]]);
    const p = resolveAndSolve(layers, "asbuilt");
    const w = wallView(p, "w1")!;
    // horizontal: endpoints level despite the 3" sketch skew
    expect(Math.abs(w.a.y - w.b.y)).toBeLessThan(0.01);
  });
});

describe("proposeAddWall", () => {
  test("free endpoints: generates junctions + wall + axis, solves", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const proposal = proposeAddWall(project, "asbuilt", {
      a: { x: s64FromFeet(20), y: 0 },
      b: { x: s64FromFeet(28), y: 0 },
      wallType: "int_2x4",
      axis: "h",
    });
    expect(proposal.wall).toBe("w1");
    expect(proposal.junctions).toEqual(["j1", "j2"]);
    const next = applyEdits(project, proposal.edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(wallView(p, "w1")!.lengthInches).toBeCloseTo(IN("8'"), 2);
  });

  test("drawing against an existing junction reuses it (shared topology)", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const proposal = proposeAddWall(project, "asbuilt", {
      a: { existing: "k.se" },
      b: { x: s64FromFeet(20), y: 0 },
      wallType: "int_2x4",
      axis: "h",
    });
    expect(proposal.junctions[0]).toBe("k.se");
    const next = applyEdits(project, proposal.edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const w = wallView(p, "w1")!;
    // starts where the room's se corner solved
    expect(w.a.x).toBeCloseTo(IN("12'"), 1);
  });

  test("names never collide with existing generated names", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const p1 = proposeAddWall(project, "asbuilt", {
      a: { x: 0, y: 0 },
      b: { x: s64FromFeet(4), y: 0 },
      wallType: "int_2x4",
    });
    const after1 = applyEdits(project, p1.edits);
    const p2 = proposeAddWall(after1, "asbuilt", {
      a: { x: 0, y: s64FromFeet(2) },
      b: { x: s64FromFeet(4), y: s64FromFeet(2) },
      wallType: "int_2x4",
    });
    expect(p2.wall).toBe("w2");
    expect(p2.junctions).toEqual(["j3", "j4"]);
  });

  test("T-join into a room wall: host splits, stem attaches at mid junction", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    // Midpoint of k.south (from sw~0,0 to se~12',0): (6', 0)
    const proposal = proposeAddWall(project, "asbuilt", {
      a: { onWall: "k.south", x: s64FromFeet(6), y: 0 },
      b: { x: s64FromFeet(6), y: s64FromFeet(-4) },
      wallType: "int_2x4",
      axis: "v",
    });
    const next = applyEdits(project, proposal.edits);
    const text = next.files.get("asbuilt.abl")!;
    // Host wall was expanded → tombstoned; stubs + mid re-authored
    expect(text).toContain("delete k.south");
    expect(text).toContain("delete k.south.length");
    expect(text).toMatch(/wall k\.south \{ from: k\.sw, to: k\.south\.j/);
    expect(text).toMatch(/wall k\.south\.b \{ from: k\.south\.j, to: k\.se/);
    // Stem uses the mid junction
    expect(proposal.junctions[0]).toBe("k.south.j");

    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Two host stubs + stem
    expect(wallView(p, "k.south")).not.toBeNull();
    expect(wallView(p, "k.south.b")).not.toBeNull();
    expect(wallView(p, proposal.wall)).not.toBeNull();
    const mid = junctionPos(p.solution, "k.south.j")!;
    expect(mid.x).toBeCloseTo(IN("6'"), 1);
    expect(mid.y).toBeCloseTo(0, 1);
    // Stubs meet at mid; their lengths sum to original width
    const a = wallView(p, "k.south")!.lengthInches;
    const b = wallView(p, "k.south.b")!.lengthInches;
    expect(a + b).toBeCloseTo(IN("12'"), 1);
  });

  test("T-join then delete the stem unsplits the host wall", () => {
    const project0 = loadProject({ "asbuilt.abl": BASE });
    const add = proposeAddWall(project0, "asbuilt", {
      a: { onWall: "k.south", x: s64FromFeet(6), y: 0 },
      b: { x: s64FromFeet(6), y: s64FromFeet(-4) },
      wallType: "int_2x4",
      axis: "v",
    });
    const split = applyEdits(project0, add.edits);
    expect(wallView(resolveAndSolve(layerMap(split), "asbuilt"), "k.south.b")).not.toBeNull();

    const next = applyEdits(split, proposeDelete(split, "asbuilt", add.wall));
    const text = next.files.get("asbuilt.abl")!;
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Mid junction and eastern stub are gone; host is one wall again.
    expect(junctionPos(p.solution, "k.south.j")).toBeNull();
    expect(wallView(p, "k.south.b")).toBeNull();
    expect(wallView(p, "k.south")).not.toBeNull();
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN("12'"), 1);
    expect(wallView(p, add.wall)).toBeNull();
    expect(text).toMatch(/wall k\.south \{ from: k\.sw, to: k\.se/);
  });

  test("T-join onto an existing stem splits it (does not delete the stem)", () => {
    // First stem off k.south, then T-join mid-stem — the stem must become two
    // stubs + mid, not vanish via unsplit-on-delete during proposeSplitWall.
    let project = loadProject({ "asbuilt.abl": BASE });
    const stem1 = proposeAddWall(project, "asbuilt", {
      a: { onWall: "k.south", x: s64FromFeet(6), y: 0 },
      b: { x: s64FromFeet(6), y: s64FromFeet(-8) },
      wallType: "int_2x4",
      axis: "v",
    });
    project = applyEdits(project, stem1.edits);
    const stemName = stem1.wall;
    expect(wallView(resolveAndSolve(layerMap(project), "asbuilt"), stemName)).not.toBeNull();

    const stem2 = proposeAddWall(project, "asbuilt", {
      a: { onWall: stemName, x: s64FromFeet(6), y: s64FromFeet(-4) },
      b: { x: s64FromFeet(10), y: s64FromFeet(-4) },
      wallType: "int_2x4",
      axis: "h",
    });
    project = applyEdits(project, stem2.edits);
    const p = resolveAndSolve(layerMap(project), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Original south host still split
    expect(wallView(p, "k.south")).not.toBeNull();
    expect(wallView(p, "k.south.b")).not.toBeNull();
    // First stem still present as stubs (name reused for one stub)
    expect(wallView(p, stemName)).not.toBeNull();
    expect(wallView(p, `${stemName}.b`) ?? wallView(p, `${stemName}.b1`)).toBeTruthy();
    expect(junctionPos(p.solution, `${stemName}.j`) ?? junctionPos(p.solution, stem2.junctions[0]!)).toBeTruthy();
    expect(wallView(p, stem2.wall)).not.toBeNull();
    // Stem length still spans ~8'
    const a = wallView(p, stemName)!.lengthInches;
    const bName = wallView(p, `${stemName}.b`) ? `${stemName}.b` : `${stemName}.b1`;
    const b = wallView(p, bName)!.lengthInches;
    expect(a + b).toBeCloseTo(IN("8'"), 1);
  });

  test("T-join then delete the mid host segment opens the expansion", () => {
    // Two T-joins on k.south at 4' and 8', with a U of walls south of them.
    // Then delete the middle host segment (k.south between the two mids) —
    // after sequential splits the middle piece is the residual between mids.
    let project = loadProject({ "asbuilt.abl": BASE });
    // First stem at 4'
    let prop = proposeAddWall(project, "asbuilt", {
      a: { onWall: "k.south", x: s64FromFeet(4), y: 0 },
      b: { x: s64FromFeet(4), y: s64FromFeet(-5) },
      wallType: "int_2x4",
      axis: "v",
    });
    project = applyEdits(project, prop.edits);
    const jWest = prop.junctions[0]!;
    // Second stem at 8' — host is now split; the eastern stub still covers x=8'
    // Find which wall contains x=8': after first split, k.south is 0→4, k.south.b is 4→12
    prop = proposeAddWall(project, "asbuilt", {
      a: { onWall: "k.south.b", x: s64FromFeet(8), y: 0 },
      b: { x: s64FromFeet(8), y: s64FromFeet(-5) },
      wallType: "int_2x4",
      axis: "v",
    });
    project = applyEdits(project, prop.edits);
    const jEast = prop.junctions[0]!;
    // After second split of k.south.b: k.south.b is 4→8, k.south.b.b is 8→12
    // Delete the middle segment k.south.b (between the two T-joins)
    project = applyEdits(project, proposeDelete(project, "asbuilt", "k.south.b"));
    const p = resolveAndSolve(layerMap(project), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.resolved.effective.has("k.south.b")).toBe(false);
    // Outer stubs remain
    expect(wallView(p, "k.south")).not.toBeNull(); // 0→4
    expect(wallView(p, "k.south.b.b") ?? wallView(p, "k.south.b1")).toBeTruthy();
    // Both T junctions still exist
    expect(junctionPos(p.solution, jWest)).not.toBeNull();
    expect(junctionPos(p.solution, jEast)).not.toBeNull();
  });
});

describe("proposeSplitWall", () => {
  test("splits a free wall and rehosts an opening onto the right stub", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

junction a ~(0", 0")
junction b ~(12'-0", 0")

wall w1 { from: a, to: b, type: int_2x4 }

axis w1 h

door d1 { in: w1, at: 1'-0" from a, size: 2'-8" x 6'-8" }
`;
    const project = loadProject({ "asbuilt.abl": src });
    // Split at 8' — door center is at 1'+1.333 ≈ 2.3', so stays on west stub
    const split = proposeSplitWall(project, "asbuilt", "w1", {
      x: s64FromFeet(8),
      y: 0,
    });
    const next = applyEdits(project, split.edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const door = p.resolved.effective.get("d1");
    expect(door?.stmt.kind).toBe("opening");
    if (door?.stmt.kind === "opening") {
      expect(door.stmt.wall).toBe("w1"); // west stub reuses host name
      expect(door.stmt.anchor).toBe("a");
    }
    expect(wallView(p, "w1")!.lengthInches).toBeCloseTo(IN("8'"), 1);
    expect(wallView(p, split.wallB)!.lengthInches).toBeCloseTo(IN("4'"), 1);
  });

  test("refuses a split too close to an endpoint", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    expect(() =>
      proposeSplitWall(project, "asbuilt", "k.south", {
        x: s64FromInches(1),
        y: 0,
      }),
    ).toThrow(/too close/);
  });
});

describe("proposeDelete", () => {
  test("own authored wall: lines blanked in place", () => {
    const project0 = loadProject({ "asbuilt.abl": BASE });
    const add = proposeAddWall(project0, "asbuilt", {
      a: { x: s64FromFeet(20), y: 0 },
      b: { x: s64FromFeet(28), y: 0 },
      wallType: "int_2x4",
      axis: "h",
    });
    const project = applyEdits(project0, add.edits);
    const edits = proposeDelete(project, "asbuilt", "w1");
    // wall + axis blanked (plus any bake rewrites); no tombstones required
    expect(edits.some((e) => e.kind === "replace-line" && e.newText === "")).toBe(true);
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.resolved.effective.has("w1")).toBe(false);
    expect(p.resolved.effective.has("w1.axis")).toBe(false);
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("deleting a wall does not drift other junctions (bake solved pose)", () => {
    // Free wall with sketch at 12' but hard length 10' → solved b is at 10',
    // sketch still 12'. A sibling free wall shares junction a. Deleting the
    // sibling used to let soft sketch pull b back toward 12'; baking pins it.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

junction a ~(0", 0")
junction b ~(12'-0", 0")
junction c ~(0", 6'-0")

wall w1 { from: a, to: b, type: int_2x4 }
wall w2 { from: a, to: c, type: int_2x4 }

axis w1 h
axis w2 v

length(w1) = 10'-0"
`;
    let project = loadProject({ "asbuilt.abl": src });
    const before = resolveAndSolve(layerMap(project), "asbuilt");
    const bBefore = junctionPos(before.solution, "b")!;
    expect(bBefore.x).toBeCloseTo(IN("10'"), 1); // hard length wins over sketch

    project = applyEdits(project, proposeDelete(project, "asbuilt", "w2"));
    const after = resolveAndSolve(layerMap(project), "asbuilt");
    const bAfter = junctionPos(after.solution, "b")!;
    expect(bAfter.x).toBeCloseTo(bBefore.x, 1);
    expect(bAfter.y).toBeCloseTo(bBefore.y, 1);
    // Bake rewrote b's sketch to the solved 10' so soft regularizer agrees.
    expect(project.files.get("asbuilt.abl")).toMatch(/junction b ~\(10'-0", 0"\)/);
  });

  test("template-expanded wall: tombstoned, with its bindings", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const edits = proposeDelete(project, "asbuilt", "k.east");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.kind).toBe("append");
    if (edits[0]!.kind !== "append") return;
    expect(edits[0]!.lines.sort()).toEqual([
      "delete k.east",
      "delete k.east.axis",
      "delete k.east.length",
    ]);
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.resolved.effective.has("k.east")).toBe(false);
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("concept deleting a base wall: tombstone in the concept only", () => {
    const project0 = loadProject({
      "asbuilt.abl": BASE,
      "concepts/open.abl": `layer open : asbuilt\n`,
    });
    const edits = proposeDelete(project0, "open", "k.east");
    expect(edits[0]!.kind).toBe("append");
    if (edits[0]!.kind !== "append") return;
    expect(edits[0]!.file).toBe("concepts/open.abl");
    const next = applyEdits(project0, edits);
    expect(
      resolveAndSolve(layerMap(next), "open").resolved.effective.has("k.east"),
    ).toBe(false);
    expect(
      resolveAndSolve(layerMap(next), "asbuilt").resolved.effective.has("k.east"),
    ).toBe(true);
  });
});

describe("createConcept", () => {
  test("creates a valid child layer", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const next = createConcept(project, "galley", "asbuilt");
    expect(next.files.get("concepts/galley.abl")).toBe("layer galley : asbuilt\n");
    const p = resolveAndSolve(layerMap(next), "galley");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("12'"), 2);
  });

  test("rejects duplicates and bad names", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    expect(() => createConcept(project, "asbuilt", "asbuilt")).toThrow(/exists/);
    expect(() => createConcept(project, "Bad Name", "asbuilt")).toThrow(/bad concept/);
    expect(() => createConcept(project, "x", "nope")).toThrow(/unknown parent/);
  });
});
