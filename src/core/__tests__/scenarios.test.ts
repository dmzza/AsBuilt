import { describe, expect, test } from "vitest";
import { parseLayerFile } from "../parser";
import {
  allParams,
  resolveAndSolve,
  wallLengthGrade,
  wallView,
} from "../model";
import { parseLength } from "../units";

const IN = (s: string): number => parseLength(s) / 64;

function project(files: Record<string, string>) {
  const layers = new Map();
  for (const [file, text] of Object.entries(files)) {
    const parsed = parseLayerFile(file, text);
    layers.set(parsed.header.name, parsed);
  }
  return layers;
}

// ---------------------------------------------------------------------------
// (a) rect room: one width param drives both walls
// ---------------------------------------------------------------------------

const RECT_ASBUILT = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;

describe("(a) rect propagation: change width, both walls move", () => {
  test("baseline: north and south both solve to width", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": RECT_ASBUILT }), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.solution.converged).toBe(true);
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("12'"), 3);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN("12'"), 3);
    expect(wallView(p, "k.east")!.lengthInches).toBeCloseTo(IN("10'"), 3);
  });

  test("editing the one param moves both walls", () => {
    const edited = RECT_ASBUILT.replace(`12'-0" [approximated]`, `11'-8 1/2" [measured]`);
    const p = resolveAndSolve(project({ "asbuilt.abl": edited }), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`11'-8 1/2"`), 3);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`11'-8 1/2"`), 3);
  });

  test("provenance: wall length inherits the width param's grade", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": RECT_ASBUILT }), "asbuilt");
    const north = wallLengthGrade(p, "k.north");
    expect(north.grade).toBe("approximated");
    expect(north.support).toContain("k.width");
    const east = wallLengthGrade(p, "k.east");
    expect(east.grade).toBe("measured");
    expect(east.support).toContain("k.depth");
  });
});

// ---------------------------------------------------------------------------
// (b) contradiction -> relax to trapezoid
// ---------------------------------------------------------------------------

const TRAP_BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)

meas m_north : dist(k.nw, k.ne) = 12'-0" [measured 2026-07-02]
meas m_south : dist(k.sw, k.se) = 11'-11" [measured 2026-07-02]
`;

describe("(b) measured north != south: contradiction, then trapezoid", () => {
  test("both measured: contradiction reported with the right suspects", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": TRAP_BASE }), "asbuilt");
    expect(p.solution.contradictions.length).toBeGreaterThan(0);
    const suspects = new Set(p.solution.contradictions.flatMap((c) => c.suspects));
    expect(suspects.has("m_north") || suspects.has("m_south")).toBe(true);
    // the rect default bindings are implicated too
    expect(
      [...suspects].some((s) => s.endsWith(".length") || s.endsWith(".axis")),
    ).toBe(true);
  });

  test("relaxing: unbind south length + let east slant -> clean trapezoid", () => {
    const relaxed =
      TRAP_BASE +
      `
delete k.south.length
delete k.east.axis
`;
    const p = resolveAndSolve(project({ "asbuilt.abl": relaxed }), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("12'"), 2);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`11'-11"`), 2);
    // east wall now slants: its endpoints differ in x by ~1"
    const east = wallView(p, "k.east")!;
    expect(Math.abs(east.a.x - east.b.x)).toBeGreaterThan(0.5);
    // room still closed: shared junctions by construction
  });
});

// ---------------------------------------------------------------------------
// (c) concept override + live propagation + masked correction
// ---------------------------------------------------------------------------

const C_BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 11'-6" [measured 2026-07-01]

room k : rect(k.width, k.depth)
`;

const C_CONCEPT = `layer galley : asbuilt

set k.width = 10'-0" [designed] (was 11'-6")
`;

describe("(c) concept overrides width; base correction propagates + flags", () => {
  test("concept sees its designed width", () => {
    const p = resolveAndSolve(
      project({ "asbuilt.abl": C_BASE, "concepts/galley.abl": C_CONCEPT }),
      "galley",
    );
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 3);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN("10'"), 3);
  });

  test("base depth correction flows into concept (live inheritance)", () => {
    const corrected = C_BASE.replace(`10'-0" [measured 2026-07-01]`, `9'-9" [measured 2026-07-08]`);
    const p = resolveAndSolve(
      project({ "asbuilt.abl": corrected, "concepts/galley.abl": C_CONCEPT }),
      "galley",
    );
    // width still the concept's, depth follows the base correction
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 3);
    expect(wallView(p, "k.east")!.lengthInches).toBeCloseTo(IN(`9'-9"`), 3);
    expect(p.diagnostics.filter((d) => d.code === "masked-correction")).toEqual([]);
  });

  test("base width correction under the override fires masked-correction", () => {
    const corrected = C_BASE.replace(
      `param k.width = 11'-6" [measured 2026-07-01]`,
      `param k.width = 11'-8 1/2" [measured 2026-07-08]`,
    );
    const p = resolveAndSolve(
      project({ "asbuilt.abl": corrected, "concepts/galley.abl": C_CONCEPT }),
      "galley",
    );
    const masked = p.diagnostics.filter((d) => d.code === "masked-correction");
    expect(masked).toHaveLength(1);
    expect(masked[0]!.key).toBe("k.width");
    // concept geometry unaffected: override still wins
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 3);
  });

  test("asbuilt branch itself never sees the concept override", () => {
    const p = resolveAndSolve(
      project({ "asbuilt.abl": C_BASE, "concepts/galley.abl": C_CONCEPT }),
      "asbuilt",
    );
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`11'-6"`), 3);
  });
});

// ---------------------------------------------------------------------------
// (f) L-room loop closure: unbound lengths derive, provenance propagates
// ---------------------------------------------------------------------------

const L_ROOM = `layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }

param dl.depth = 13'-0" [measured 2026-07-05]
param dl.east_depth = 8'-0" [measured 2026-07-05]
param dl.south_width = 12'-0" [approximated]
param dl.width = 20'-0" [measured 2026-07-05]

junction dl.e ~(20'-0", 5'-0")
junction dl.k ~(12'-0", 5'-0")
junction dl.ne ~(20'-0", 13'-0")
junction dl.nw ~(0", 13'-0")
junction dl.s ~(12'-0", 0")
junction dl.sw ~(0", 0")

wall dl.east { from: dl.ne, to: dl.e, type: ext_2x6 }
wall dl.inner { from: dl.k, to: dl.s, type: ext_2x6 }
wall dl.jog { from: dl.e, to: dl.k, type: ext_2x6 }
wall dl.north { from: dl.nw, to: dl.ne, type: ext_2x6 }
wall dl.south { from: dl.s, to: dl.sw, type: ext_2x6 }
wall dl.west { from: dl.sw, to: dl.nw, type: ext_2x6 }

rectilinear dl.*

length(dl.east) = dl.east_depth
length(dl.north) = dl.width
length(dl.south) = dl.south_width
length(dl.west) = dl.depth
`;

describe("(f) L-room: closure derives unbound walls with propagated provenance", () => {
  test("jog and inner derive from closure", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": L_ROOM }), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.solution.contradictions).toEqual([]);
    // jog = width - south_width = 8'; inner = depth - east_depth = 5'
    expect(wallView(p, "dl.jog")!.lengthInches).toBeCloseTo(IN("8'"), 2);
    expect(wallView(p, "dl.inner")!.lengthInches).toBeCloseTo(IN("5'"), 2);
  });

  test("provenance: jog is approximated-grade (south is a guess), inner is measured-grade", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": L_ROOM }), "asbuilt");
    const jog = wallLengthGrade(p, "dl.jog");
    expect(jog.grade).toBe("approximated");
    expect(jog.support).toContain("dl.south_width");
    const inner = wallLengthGrade(p, "dl.inner");
    expect(inner.grade).toBe("measured");
  });

  test("taping the south wall re-derives the jog and clears the audit", () => {
    const taped = L_ROOM.replace(
      `param dl.south_width = 12'-0" [approximated]`,
      `param dl.south_width = 11'-10 3/4" [measured 2026-07-08]`,
    );
    const p = resolveAndSolve(project({ "asbuilt.abl": taped }), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "dl.jog")!.lengthInches).toBeCloseTo(IN(`8'-1 1/4"`), 2);
    expect(wallLengthGrade(p, "dl.jog").grade).toBe("measured");
    const audit = allParams(p).filter((v) => v.prov === "approximated");
    expect(audit).toEqual([]);
  });

  test("over-measuring the loop: closure contradiction with named suspects", () => {
    const over =
      L_ROOM.replace(
        `param dl.south_width = 12'-0" [approximated]`,
        `param dl.south_width = 11'-10 3/4" [measured 2026-07-08]`,
      ) +
      `
meas m_jog : dist(dl.e, dl.k) = 8'-0" [measured 2026-07-08]
`;
    const p = resolveAndSolve(project({ "asbuilt.abl": over }), "asbuilt");
    expect(p.solution.contradictions.length).toBeGreaterThan(0);
    const suspects = new Set(p.solution.contradictions.flatMap((c) => c.suspects));
    expect(suspects.has("m_jog")).toBe(true);
  });
});
