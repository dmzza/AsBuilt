import { describe, expect, test } from "vitest";
import { parseLayerFile } from "../parser";
import { printLayerFile } from "../printer";
import { levelOfKey, levelViews, resolveAndSolve, wallView } from "../model";
import { junctionPos } from "../solve";
import { parseLength } from "../units";

const L = parseLength;
const IN = (s: string): number => parseLength(s) / 64;

function project(files: Record<string, string>) {
  const layers = new Map();
  for (const [file, text] of Object.entries(files)) {
    const parsed = parseLayerFile(file, text);
    layers.set(parsed.header.name, parsed);
  }
  return layers;
}

const TWO_LEVEL = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

level up.* { elev: 9'-1" [approximated] }

param lv.d = 12'-0" [measured 2026-07-01]
param lv.w = 14'-0" [approximated]
param up.m_d = 12'-0" [approximated]
param up.m_w = 14'-0" [approximated]

room lv : rect(lv.w, lv.d) { walls: int_2x4, height: 8'-0" [measured] }
room up.master : rect(up.m_w, up.m_d) { walls: int_2x4, height: 8'-0" [approximated] }

stack up.master.se on lv.se
stack up.master.sw on lv.sw

void up.stairwell { at: ~(10'-6", 1'-0"), size: 3'-0" x 10'-0" }
`;

describe("level / stack / void statements", () => {
  test("parse -> print roundtrip is canonical", () => {
    const parsed = parseLayerFile("asbuilt.abl", TWO_LEVEL);
    const printed = printLayerFile(parsed);
    expect(printLayerFile(parseLayerFile("asbuilt.abl", printed))).toBe(printed);
    expect(printed).toContain(`level up.* { elev: 9'-1" [approximated] }`);
    expect(printed).toContain("stack up.master.sw on lv.sw");
    expect(printed).toContain(`void up.stairwell { at: ~(10'-6", 1'-0"), size: 3'-0" x 10'-0" }`);
  });

  test("levelViews: ground always present, levels by elevation", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": TWO_LEVEL }), "asbuilt");
    const levels = levelViews(p);
    expect(levels.map((l) => l.ns)).toEqual([null, "up"]);
    expect(levels[1]!.elevInches).toBeCloseTo(IN("9'-1\""), 6);
    expect(levelOfKey("up.master.sw", levels)).toBe("up");
    expect(levelOfKey("up.stairwell", levels)).toBe("up");
    expect(levelOfKey("lv.sw", levels)).toBeNull();
    expect(levelOfKey("up", levels)).toBe("up");
  });

  test("stack: upper junctions solve into plan coincidence with lower", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": TWO_LEVEL }), "asbuilt");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.solution.converged).toBe(true);
    expect(p.solution.contradictions).toEqual([]);
    const lo = junctionPos(p.solution, "lv.sw")!;
    const hi = junctionPos(p.solution, "up.master.sw")!;
    expect(hi.x).toBeCloseTo(lo.x, 3);
    expect(hi.y).toBeCloseTo(lo.y, 3);
  });

  test("live inheritance across levels: measuring the ground moves the story above", () => {
    const measured = TWO_LEVEL.replace(
      `param lv.w = 14'-0" [approximated]`,
      `param lv.w = 13'-10 1/2" [measured]`,
    ).replace(
      `param up.m_w = 14'-0" [approximated]`,
      // upper width rides the lower: no independent truth
      "",
    ).replace("rect(up.m_w, up.m_d)", "rect(lv.w, up.m_d)");
    const p = resolveAndSolve(project({ "asbuilt.abl": measured }), "asbuilt");
    expect(p.solution.contradictions).toEqual([]);
    expect(wallView(p, "up.master.north")!.lengthInches).toBeCloseTo(IN(`13'-10 1/2"`), 2);
    // and the stacked corner still bears over the ground corner
    const lo = junctionPos(p.solution, "lv.se")!;
    const hi = junctionPos(p.solution, "up.master.se")!;
    expect(hi.x).toBeCloseTo(lo.x, 3);
  });

  test("a concept can re-pitch a level by shadowing its statement", () => {
    const p = resolveAndSolve(
      project({
        "asbuilt.abl": TWO_LEVEL,
        "concepts/raise.abl": `layer raise : asbuilt

level up.* { elev: 10'-1" [designed] }
`,
      }),
      "raise",
    );
    const levels = levelViews(p);
    expect(levels.find((l) => l.ns === "up")!.elevInches).toBeCloseTo(IN("10'-1\""), 6);
  });

  test("stack with a missing junction is an unknown-ref error", () => {
    const bad = TWO_LEVEL.replace("stack up.master.sw on lv.sw", "stack up.master.sw on ghost");
    const p = resolveAndSolve(project({ "asbuilt.abl": bad }), "asbuilt");
    expect(
      p.diagnostics.some((d) => d.code === "unknown-ref" && d.message.includes("ghost")),
    ).toBe(true);
  });

  test("void solves as a no-op and resolves as effective", () => {
    const p = resolveAndSolve(project({ "asbuilt.abl": TWO_LEVEL }), "asbuilt");
    const v = p.resolved.effective.get("up.stairwell");
    expect(v?.stmt.kind).toBe("void");
    if (v?.stmt.kind === "void") {
      expect(v.stmt.w).toBe(L("3'-0\""));
      expect(v.stmt.d).toBe(L("10'-0\""));
    }
  });
});
