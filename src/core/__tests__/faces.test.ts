import { describe, expect, test } from "vitest";
import {
  applyEdits,
  defaultMeasureRef,
  faceMeasureEndpoints,
  junctionPos,
  layerMap,
  loadProject,
  parseLayerFile,
  parseLength,
  printLayerFile,
  proposeMeasure,
  resolveAndSolve,
  thicknessValue,
  wallLengthGrade,
  wallView,
} from "../../core";

const IN = (s: string): number => parseLength(s) / 64;

describe("face-referenced measurement (M7)", () => {
  test("parse/print walltype thickness provenance + meas ref + room dims", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" [measured 2026-07-10] }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4, dims: inner }

meas m1 : dist(k.sw, k.se) = 11'-7 1/2" [measured 2026-07-10] { ref: inner }
`;
    const parsed = parseLayerFile("t.abl", src);
    const wt = parsed.stmts.find((s) => s.kind === "walltype");
    expect(wt?.kind).toBe("walltype");
    if (wt?.kind === "walltype") {
      expect(wt.prov).toBe("measured");
      expect(wt.date).toBe("2026-07-10");
    }
    const room = parsed.stmts.find((s) => s.kind === "room");
    expect(room?.kind).toBe("room");
    if (room?.kind === "room") expect(room.dims).toBe("inner");
    const meas = parsed.stmts.find((s) => s.kind === "meas");
    expect(meas?.kind).toBe("meas");
    if (meas?.kind === "meas") {
      expect(meas.ref).toEqual({ a: "inner", b: "inner" });
    }
    const printed = printLayerFile(parsed);
    expect(printed).toContain(`walltype int_2x4 { thickness: 4 1/2" [measured 2026-07-10] }`);
    expect(printed).toContain(`dims: inner`);
    expect(printed).toContain(`{ ref: inner }`);
    // round-trip stable
    expect(printLayerFile(parseLayerFile("t.abl", printed))).toBe(printed);
  });

  test("legacy walltype without provenance prints without bracket (byte-stable)", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }
`;
    const printed = printLayerFile(parseLayerFile("t.abl", src));
    expect(printed).toContain(`walltype int_2x4 { thickness: 4 1/2" }`);
    expect(printed).not.toContain(`[approximated]`);
  });

  test("inner tape on a room wall: centerline = tape + full thickness (equal ends)", () => {
    // 2×4 = 4.5"; both ends same type → C = M_inner + T
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas m1 : dist(k.sw, k.se) = 11'-7 1/2" [measured] { ref: inner }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    const south = wallView(p, "k.south")!;
    // 11'-7 1/2" + 4 1/2" = 12'-0"
    expect(south.lengthInches).toBeCloseTo(IN(`12'-0"`), 2);
    expect(south.faces.inner).toBeCloseTo(IN(`11'-7 1/2"`), 2);
    expect(south.faces.outer).toBeCloseTo(IN(`12'-4 1/2"`), 2);
  });

  test("outer tape: centerline = tape − full thickness", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas m1 : dist(k.sw, k.se) = 12'-4 1/2" [measured] { ref: outer }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`12'-0"`), 2);
  });

  test("dims:inner on rect: param is clear interior, centerline grows by thickness", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [measured]
param k.w = 11'-7 1/2" [measured]

room k : rect(k.w, k.d) { walls: int_2x4, dims: inner }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    // width param is interior; C_width = 11'-7.5" + 4.5" = 12'
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`12'-0"`), 2);
    // depth: 10' + 4.5" = 10'-4.5"
    expect(wallView(p, "k.east")!.lengthInches).toBeCloseTo(IN(`10'-4 1/2"`), 2);
  });

  test("face measure of param-bound wall appends meas (never freezes derived centerline)", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }
`;
    const project = loadProject({ "asbuilt.abl": src });
    const edits = proposeMeasure(
      project,
      "asbuilt",
      { wall: "k.north" },
      parseLength(`11'-7 1/2"`),
      "2026-07-10",
      "inner",
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]!.kind).toBe("append");
    if (edits[0]!.kind !== "append") return;
    expect(edits[0]!.lines[0]).toBe(
      `meas m1 : dist(k.ne, k.nw) = 11'-7 1/2" [measured 2026-07-10] { ref: inner }`,
    );
    // param stays approximated — solver owns centerline
    const next = applyEdits(project, edits);
    const text = next.files.get("asbuilt.abl")!;
    expect(text).toContain(`param k.w = 12'-0" [approximated]`);
    expect(text).not.toMatch(/param k\.w = 11'/);

    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    // C = M_inner + T = 11'-7½" + 4½" = 12'-0"; thickness must NOT collapse
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`12'-0"`), 2);
    const ti = p.solution.system.varIndex.get("t:int_2x4")!;
    expect(p.solution.x[ti]!).toBeCloseTo(4.5, 1);
  });

  test("soft face measure moves free params, not catalog thickness", () => {
    // Regression: equal soft weights used to split → t≈2.25", C≈140".
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 11'-6" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }
`;
    const project = loadProject({ "asbuilt.abl": src });
    const next = applyEdits(
      project,
      proposeMeasure(
        project,
        "asbuilt",
        { wall: "k.north" },
        parseLength(`11'-6"`),
        "2026-07-10",
        "inner",
      ),
    );
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    const ti = p.solution.system.varIndex.get("t:int_2x4")!;
    expect(p.solution.x[ti]!).toBeCloseTo(4.5, 1);
    // C = 11'-6" + 4½" = 11'-10½"
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`11'-10 1/2"`), 1);
    expect(wallView(p, "k.north")!.faces.inner).toBeCloseTo(IN(`11'-6"`), 1);
  });

  test("faceMeasureEndpoints inset to crossing faces (drawn length = tape span)", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas m1 : dist(k.sw, k.se) = 11'-7 1/2" [measured] { ref: inner }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    const ends = faceMeasureEndpoints(
      p.resolved,
      (n) => junctionPos(p.solution, n),
      (wt) => thicknessValue(p.solution, wt) ?? 4.5,
      "k.sw",
      "k.se",
      { a: "inner", b: "inner" },
      { x: 72, y: 60 }, // room interior
    );
    expect(ends).not.toBeNull();
    const drawn = Math.hypot(ends!.b.x - ends!.a.x, ends!.b.y - ends!.a.y);
    // Drawn span must match the tape value, not the centerline junction distance.
    expect(drawn).toBeCloseTo(IN(`11'-7 1/2"`), 1);
    const cLen = wallView(p, "k.south")!.lengthInches;
    expect(cLen).toBeCloseTo(IN(`12'-0"`), 1);
    expect(drawn).toBeLessThan(cLen - 1); // clearly shorter than junction-to-junction
  });

  test("defaultMeasureRef follows room dims, else centerline", () => {
    const cl = resolveAndSolve(
      layerMap(
        loadProject({
          "asbuilt.abl": `layer asbuilt
walltype int_2x4 { thickness: 4 1/2" }
param k.w = 12'-0" [approximated]
param k.d = 10'-0" [approximated]
room k : rect(k.w, k.d) { walls: int_2x4 }
`,
        }),
      ),
      "asbuilt",
    );
    expect(defaultMeasureRef(cl, { wall: "k.south" })).toBe("centerline");

    const inn = resolveAndSolve(
      layerMap(
        loadProject({
          "asbuilt.abl": `layer asbuilt
walltype int_2x4 { thickness: 4 1/2" }
param k.w = 12'-0" [approximated]
param k.d = 10'-0" [approximated]
room k : rect(k.w, k.d) { walls: int_2x4, dims: inner }
`,
        }),
      ),
      "asbuilt",
    );
    expect(defaultMeasureRef(inn, { wall: "k.south" })).toBe("inner");
  });

  test("centerline measure still promotes the bound param", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }
`;
    const project = loadProject({ "asbuilt.abl": src });
    const edits = proposeMeasure(
      project,
      "asbuilt",
      { wall: "k.north" },
      parseLength(`11'-8 1/2"`),
      "2026-07-10",
      "centerline",
    );
    expect(edits[0]!.kind).toBe("replace-line");
    if (edits[0]!.kind !== "replace-line") return;
    expect(edits[0]!.newText).toBe(`param k.w = 11'-8 1/2" [measured 2026-07-10]`);
  });

  test("inner + outer of same span with soft thickness derives true thickness", () => {
    // True centerline 12', true thickness 5". Inner = 11'-7", outer = 12'-5".
    // Authored thickness is soft 4.5"; two hard face meases should pull it to 5".
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas mi : dist(k.sw, k.se) = 11'-7" [measured] { ref: inner }
meas mo : dist(k.sw, k.se) = 12'-5" [measured] { ref: outer }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    const t = p.solution.system.varIndex.get("t:int_2x4");
    expect(t).toBeDefined();
    expect(p.solution.x[t!]!).toBeCloseTo(5, 1);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`12'-0"`), 1);
  });

  test("contradiction with face meases lists walltype among suspects", () => {
    // Two hard inner meases that disagree given the thickness → walltype suspect.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" [measured] }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas m_south : dist(k.sw, k.se) = 11'-7 1/2" [measured] { ref: inner }
meas m_north : dist(k.nw, k.ne) = 11'-0" [measured] { ref: inner }
`;
    // equal-opposite walls + equal face meases that imply different centerlines
    // with fixed thickness → contradiction; walltype shares thickness vars.
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    expect(p.solution.contradictions.length).toBeGreaterThan(0);
    const suspects = new Set(p.solution.contradictions.flatMap((c) => c.suspects));
    expect(suspects.has("m_south") || suspects.has("m_north")).toBe(true);
    // thickness is hard and participates in face residuals
    expect(suspects.has("int_2x4")).toBe(true);
  });

  test("wall length grade weakens through approximated thickness", () => {
    // Measured face tape + approximated thickness → derived centerline grade is approximated.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.d = 10'-0" [approximated]
param k.w = 12'-0" [approximated]

room k : rect(k.w, k.d) { walls: int_2x4 }

meas m1 : dist(k.sw, k.se) = 11'-7 1/2" [measured] { ref: inner }
`;
    const p = resolveAndSolve(layerMap(loadProject({ "asbuilt.abl": src })), "asbuilt");
    const g = wallLengthGrade(p, "k.south");
    expect(g.support).toContain("m1");
    expect(g.support).toContain("int_2x4");
    expect(g.grade).toBe("approximated"); // weakest of measured meas + approx thickness
  });
});
