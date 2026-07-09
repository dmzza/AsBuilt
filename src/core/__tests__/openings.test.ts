import { describe, expect, test } from "vitest";
import {
  applyEdits,
  layerMap,
  loadProject,
  proposeAddFixture,
  proposeAddOpening,
  proposeDelete,
  proposeSetFixture,
  proposeSetOpening,
  proposeSetOpeningOffset,
  proposeSetWallType,
} from "../editkit";
import { fixtureViews, openingViews, resolveAndSolve } from "../model";
import { parseLayerFile } from "../parser";
import { printLayerFile } from "../printer";
import { parseLength } from "../units";

const IN = (s: string): number => parseLength(s) / 64;

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;

describe("opening/fixture language", () => {
  test("round-trips canonically", () => {
    const text = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

door d1 { in: k.north, at: 2'-0" from k.nw, size: 2'-8" x 6'-8" }
window win1 { in: k.south, at: 3'-0" from k.se, size: 3'-0" x 3'-0", sill: 2'-6" }

room k : rect(k.width, k.depth)

fixture f1 { kind: fridge, at: ~(5'-0", 5'-0"), size: 3'-0" x 2'-6", rot: 90 }
`;
    const parsed = parseLayerFile("a.abl", text);
    expect(printLayerFile(parsed)).toBe(text);
  });

  test("merge validates host wall and anchor endpoint", () => {
    const bad = `${BASE}
door d1 { in: nope, at: 2'-0" from k.nw, size: 2'-8" x 6'-8" }

door d2 { in: k.north, at: 2'-0" from k.sw, size: 2'-8" x 6'-8" }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": bad })), "asbuilt");
    const errors = p.diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((d) => d.key === "d1")).toBe(true);
    expect(errors.some((d) => d.key === "d2" && /not an endpoint/.test(d.message))).toBe(
      true,
    );
  });

  test("openingViews: far-end anchoring measures back from the wall's to-end", () => {
    // k.north runs ne -> nw (rect template CCW). Anchor at k.nw (the `to`
    // end): offset is measured backwards from nw.
    const text = `${BASE}
door d1 { in: k.north, at: 2'-0" from k.nw, size: 2'-8" x 6'-8" }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": text })), "asbuilt");
    const [view] = openingViews(p);
    expect(view).toBeDefined();
    expect(view!.overflow).toBe(false);
    // nw is at x=0 (west); jamb nearest nw should be 2' from it: x = 2'
    const nearX = Math.min(view!.jambA.x, view!.jambB.x);
    expect(nearX).toBeCloseTo(IN("2'"), 1);
    expect(Math.abs(view!.jambB.x - view!.jambA.x)).toBeCloseTo(IN(`2'-8"`), 1);
  });

  test("overflow flagged when the opening exceeds its wall", () => {
    const text = `${BASE}
door d1 { in: k.north, at: 11'-0" from k.nw, size: 2'-8" x 6'-8" }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": text })), "asbuilt");
    expect(openingViews(p)[0]!.overflow).toBe(true);
  });
});

describe("opening/fixture edit generators", () => {
  test("proposeAddOpening anchors to the nearer end and clamps", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    // center at 2' along a 12' wall -> near the from end (k.ne for k.north)
    const near = proposeAddOpening(project, "asbuilt", {
      wall: "k.north",
      opKind: "door",
      centerAlong: IN("2'"),
    });
    expect(near.edits[0]!.kind).toBe("append");
    if (near.edits[0]!.kind !== "append") return;
    expect(near.edits[0]!.lines[0]).toContain("from k.ne");

    // center at 11' -> anchored to the far (to) end, k.nw
    const far = proposeAddOpening(project, "asbuilt", {
      wall: "k.north",
      opKind: "window",
      centerAlong: IN("11'"),
    });
    if (far.edits[0]!.kind !== "append") return;
    expect(far.edits[0]!.lines[0]).toContain("from k.nw");
    expect(far.edits[0]!.lines[0]).toContain("sill: 2'-6\"");

    // both resolve cleanly and render in range
    let world = applyEdits(project, near.edits);
    world = applyEdits(world, far.edits);
    const p = resolveAndSolve(layerMap(world), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const views = openingViews(p);
    expect(views).toHaveLength(2);
    expect(views.every((v) => !v.overflow)).toBe(true);
  });

  test("slide + delete an opening", () => {
    const project0 = loadProject({ "asbuilt.abl": BASE });
    const add = proposeAddOpening(project0, "asbuilt", {
      wall: "k.north",
      opKind: "door",
      centerAlong: IN("3'"),
    });
    let world = applyEdits(project0, add.edits);
    world = applyEdits(
      world,
      proposeSetOpeningOffset(world, "asbuilt", add.name, parseLength(`4'-0"`)),
    );
    const p = resolveAndSolve(layerMap(world), "asbuilt");
    const [v] = openingViews(p);
    expect(v!.offsetInches).toBeCloseTo(IN("4'"), 3);

    world = applyEdits(world, proposeDelete(world, "asbuilt", add.name));
    expect(openingViews(resolveAndSolve(layerMap(world), "asbuilt"))).toHaveLength(0);
  });

  test("fixtures: add, move, rotate; concept shadowing keeps as-built clean", () => {
    const project0 = loadProject({
      "asbuilt.abl": BASE,
      "concepts/c.abl": "layer c : asbuilt\n",
    });
    const add = proposeAddFixture(project0, "asbuilt", {
      at: { x: parseLength(`3'`), y: parseLength(`3'`) },
      fixKind: "fridge",
      w: parseLength(`3'`),
      d: parseLength(`2'-6"`),
    });
    let world = applyEdits(project0, add.edits);

    // concept moves the fridge: shadow lands in the concept file
    const move = proposeSetFixture(world, "c", add.name, {
      at: { x: parseLength(`8'`), y: parseLength(`3'`) },
      rot: 90,
    });
    expect(move[0]!.kind).toBe("append");
    if (move[0]!.kind !== "append") return;
    expect(move[0]!.file).toBe("concepts/c.abl");
    world = applyEdits(world, move);

    const concept = fixtureViews(resolveAndSolve(layerMap(world), "c"))[0]!;
    expect(concept.x).toBeCloseTo(IN("8'"), 3);
    expect(concept.rot).toBe(90);
    const asbuilt = fixtureViews(resolveAndSolve(layerMap(world), "asbuilt"))[0]!;
    expect(asbuilt.x).toBeCloseTo(IN("3'"), 3);
    expect(asbuilt.rot).toBe(0);
  });

  test("proposeSetOpening edits width/sill in place", () => {
    const project0 = loadProject({ "asbuilt.abl": BASE });
    const add = proposeAddOpening(project0, "asbuilt", {
      wall: "k.north",
      opKind: "window",
      centerAlong: IN("6'"),
    });
    let world = applyEdits(project0, add.edits);
    world = applyEdits(
      world,
      proposeSetOpening(world, "asbuilt", add.name, {
        width: parseLength(`4'-0"`),
        sill: parseLength(`3'-0"`),
      }),
    );
    const p = resolveAndSolve(layerMap(world), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [v] = openingViews(p);
    expect(v!.widthInches).toBeCloseTo(IN("4'"), 3);
    expect(v!.sillInches).toBeCloseTo(IN("3'"), 3);
  });

  test("proposeSetWallType: unknown type throws; expanded wall is shadowed", () => {
    const base = `layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth) { walls: int_2x4 }
`;
    const project = loadProject({ "asbuilt.abl": base });
    expect(() => proposeSetWallType(project, "asbuilt", "k.north", "nope")).toThrow(
      /no walltype/,
    );
    // k.north comes from the rect template: the edit restates (shadows) it
    const edits = proposeSetWallType(project, "asbuilt", "k.north", "ext_2x6");
    expect(edits[0]!.kind).toBe("append");
    const world = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(world), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const eff = p.resolved.effective.get("k.north")!;
    expect(eff.stmt.kind === "wall" && eff.stmt.wallType).toBe("ext_2x6");
  });
});
