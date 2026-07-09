import { describe, expect, test } from "vitest";
import {
  applyEdits,
  layerMap,
  loadProject,
  proposeAddWall,
  proposeDelete,
  proposeMeasure,
  proposeSetParam,
} from "../editkit";
import { allWallGrades, resolveAndSolve, wallLengthGrade, wallView } from "../model";
import { parseLength, s64FromFeet } from "../units";

const IN = (s: string): number => parseLength(s) / 64;

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;

describe("proposeMeasure routing", () => {
  test("measuring a param-bound wall promotes the param to measured", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const edits = proposeMeasure(
      project,
      "asbuilt",
      { wall: "k.north" },
      parseLength(`11'-8 1/2"`),
      "2026-07-09",
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]!.kind).toBe("replace-line");
    if (edits[0]!.kind !== "replace-line") return;
    expect(edits[0]!.newText).toBe(`param k.width = 11'-8 1/2" [measured 2026-07-09]`);
    // no duplicate meas: both walls follow the one param
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`11'-8 1/2"`), 2);
  });

  test("measuring a drawn (unbound) wall appends a meas and upgrades its grade", () => {
    const p0 = loadProject({ "asbuilt.abl": BASE });
    const add = proposeAddWall(p0, "asbuilt", {
      a: { x: s64FromFeet(20), y: 0 },
      b: { x: s64FromFeet(28), y: 0 },
      wallType: "int_2x4",
      axis: "h",
    });
    const p1 = applyEdits(p0, add.edits);
    expect(wallLengthGrade(resolveAndSolve(layerMap(p1), "asbuilt"), "w1").grade).toBe(
      "drawn",
    );

    const edits = proposeMeasure(p1, "asbuilt", { wall: "w1" }, parseLength(`8'-2"`), "2026-07-09");
    expect(edits[0]!.kind).toBe("append");
    if (edits[0]!.kind !== "append") return;
    expect(edits[0]!.lines).toEqual([`meas m1 : dist(j1, j2) = 8'-2" [measured 2026-07-09]`]);

    const p2 = applyEdits(p1, edits);
    const pipeline = resolveAndSolve(layerMap(p2), "asbuilt");
    expect(pipeline.solution.contradictions).toEqual([]);
    expect(wallView(pipeline, "w1")!.lengthInches).toBeCloseTo(IN(`8'-2"`), 2);
    const grade = wallLengthGrade(pipeline, "w1");
    expect(grade.grade).toBe("measured");
    expect(grade.support).toContain("m1");
    // batch variant agrees
    expect(allWallGrades(pipeline).get("w1")!.grade).toBe("measured");
  });

  test("junction-pair measure (diagonal) appends a meas", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const edits = proposeMeasure(
      project,
      "asbuilt",
      { a: "k.sw", b: "k.ne" },
      parseLength(`15'-7 1/4"`),
    );
    expect(edits[0]!.kind).toBe("append");
    if (edits[0]!.kind !== "append") return;
    expect(edits[0]!.lines).toEqual([`meas m1 : dist(k.sw, k.ne) = 15'-7 1/4" [measured]`]);
  });
});

describe("contradiction resolution via core APIs", () => {
  test("diagonal disagrees with rectangle: demoting the width param resolves", () => {
    // width approximated 12', depth measured 10' -> rect diagonal 15'-7.4".
    // measure the diagonal as 15'-3" -> solver pulls width to close, fine
    // (width is soft). Then ALSO measure width 12' -> now hard vs hard.
    const project = loadProject({ "asbuilt.abl": BASE });
    const d = applyEdits(
      project,
      proposeMeasure(project, "asbuilt", { a: "k.sw", b: "k.ne" }, parseLength(`15'-3"`)),
    );
    expect(resolveAndSolve(layerMap(d), "asbuilt").solution.contradictions).toEqual([]);

    const w = applyEdits(
      d,
      proposeSetParam(d, "asbuilt", "k.width", parseLength(`12'-0"`), "measured"),
    );
    const conflicted = resolveAndSolve(layerMap(w), "asbuilt");
    expect(conflicted.solution.contradictions.length).toBeGreaterThan(0);
    const suspects = new Set(
      conflicted.solution.contradictions.flatMap((c) => c.suspects),
    );
    expect(suspects.has("m1")).toBe(true);

    // resolution A: demote the width back to approximated
    const demoted = applyEdits(
      w,
      proposeSetParam(w, "asbuilt", "k.width", parseLength(`12'-0"`), "approximated"),
    );
    expect(resolveAndSolve(layerMap(demoted), "asbuilt").solution.contradictions).toEqual(
      [],
    );

    // resolution B: remove the diagonal meas instead
    const removed = applyEdits(w, proposeDelete(w, "asbuilt", "m1"));
    expect(resolveAndSolve(layerMap(removed), "asbuilt").solution.contradictions).toEqual(
      [],
    );
  });

  test("relaxing a rect default through proposeDelete yields the trapezoid", () => {
    const withMeas = `${BASE}
meas m_north : dist(k.nw, k.ne) = 12'-0" [measured]
meas m_south : dist(k.sw, k.se) = 11'-11" [measured]
`;
    const project = loadProject({ "asbuilt.abl": withMeas });
    expect(
      resolveAndSolve(layerMap(project), "asbuilt").solution.contradictions.length,
    ).toBeGreaterThan(0);

    let world = applyEdits(project, proposeDelete(project, "asbuilt", "k.south.length"));
    world = applyEdits(world, proposeDelete(world, "asbuilt", "k.east.axis"));
    const p = resolveAndSolve(layerMap(world), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`11'-11"`), 2);
  });
});
