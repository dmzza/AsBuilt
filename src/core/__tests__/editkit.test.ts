import { describe, expect, test } from "vitest";
import {
  applyEdits,
  createConcept,
  layerMap,
  loadProject,
  proposeAddWall,
  proposeDelete,
} from "../editkit";
import { resolveAndSolve, wallView } from "../model";
import { parseLayerFile } from "../parser";
import { printLayerFile } from "../printer";
import { parseLength, s64FromFeet } from "../units";

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
    // wall + axis lines blanked, no tombstones
    expect(edits.every((e) => e.kind === "replace-line")).toBe(true);
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.resolved.effective.has("w1")).toBe(false);
    expect(p.resolved.effective.has("w1.axis")).toBe(false);
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
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
