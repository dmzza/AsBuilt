import { describe, expect, test } from "vitest";
import { DEMO_FILES } from "../../demo";
import {
  applyEdits,
  layerMap,
  loadProject,
  proposeDropOrphan,
  proposeMeasure,
  proposeReparent,
  proposeResolveMasked,
  proposeSetParam,
  type Project,
} from "../editkit";
import { resolveAndSolve, wallView } from "../model";
import { parseLength } from "../units";

const L = parseLength;
const IN = (s: string): number => parseLength(s) / 64;

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 11'-6" [approximated]

room k : rect(k.width, k.depth)
`;

function fixture(): Project {
  return loadProject({
    "asbuilt.abl": BASE,
    "concepts/galley.abl": `layer galley : asbuilt

set k.width = 9'-6" [designed] (was 11'-6")
`,
    "concepts/attic.abl": `layer attic : galley
`,
  });
}

describe("re-parenting", () => {
  test("rewrites the header line; chain re-resolves", () => {
    const project = fixture();
    const next = applyEdits(project, proposeReparent(project, "attic", "asbuilt"));
    expect(next.files.get("concepts/attic.abl")!.split("\n")[0]).toBe(
      "layer attic : asbuilt",
    );
    const p = resolveAndSolve(layerMap(next), "attic");
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.resolved.chain).toEqual(["asbuilt", "attic"]);
    // attic no longer inherits galley's override
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("11'-6\""), 3);
  });

  test("cycle rejected: cannot parent onto own descendant", () => {
    const project = fixture();
    expect(() => proposeReparent(project, "galley", "attic")).toThrow(/cycle/);
  });

  test("self, root, and unknown parents rejected", () => {
    const project = fixture();
    expect(() => proposeReparent(project, "galley", "galley")).toThrow(/itself/);
    expect(() => proposeReparent(project, "asbuilt", "galley")).toThrow(/root/);
    expect(() => proposeReparent(project, "galley", "nope")).toThrow(/unknown parent/);
  });

  test("re-parenting onto the current parent is a no-op", () => {
    const project = fixture();
    expect(proposeReparent(project, "galley", "asbuilt")).toEqual([]);
  });
});

describe("masked-correction resolution", () => {
  function measuredBase(): Project {
    const project = fixture();
    return applyEdits(
      project,
      proposeSetParam(project, "asbuilt", "k.width", L("11'-8 1/2\""), "measured"),
    );
  }

  test("base correction raises the flag; designed override holds", () => {
    const p = resolveAndSolve(layerMap(measuredBase()), "galley");
    const masked = p.diagnostics.filter((d) => d.code === "masked-correction");
    expect(masked).toHaveLength(1);
    expect(masked[0]!.key).toBe("k.width");
    expect(masked[0]!.data).toEqual({
      base: L("11'-8 1/2\""),
      was: L("11'-6\""),
      override: L("9'-6\""),
    });
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("9'-6\""), 3);
  });

  test("keep: (was ...) acknowledges the new base, value holds, flag clears", () => {
    const project = measuredBase();
    const next = applyEdits(
      project,
      proposeResolveMasked(project, "galley", "k.width", "keep"),
    );
    expect(next.files.get("concepts/galley.abl")).toContain("(was 11'-8 1/2\")");
    const p = resolveAndSolve(layerMap(next), "galley");
    expect(p.diagnostics.filter((d) => d.code === "masked-correction")).toEqual([]);
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("9'-6\""), 3);
  });

  test("adopt: override removed, base value shows through", () => {
    const project = measuredBase();
    const next = applyEdits(
      project,
      proposeResolveMasked(project, "galley", "k.width", "adopt"),
    );
    const p = resolveAndSolve(layerMap(next), "galley");
    expect(p.diagnostics.filter((d) => d.code === "masked-correction")).toEqual([]);
    const eff = p.resolved.effective.get("k.width")!;
    expect(eff.stmt.kind).toBe("param");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("11'-8 1/2\""), 3);
  });

  test("an ancestor's override must be resolved on its own sheet", () => {
    const project = measuredBase();
    expect(() => proposeResolveMasked(project, "attic", "k.width", "keep")).toThrow(
      /resolve it on that sheet/,
    );
  });
});

describe("orphan drop", () => {
  test("set whose base param is gone: flagged, then dropped", () => {
    const project = loadProject({
      "asbuilt.abl": BASE,
      "concepts/galley.abl": `layer galley : asbuilt

set q.ghost = 4'-0" [designed] (was 3'-0")
`,
    });
    const before = resolveAndSolve(layerMap(project), "galley");
    expect(before.diagnostics.some((d) => d.code === "set-missing-base")).toBe(true);
    const next = applyEdits(project, proposeDropOrphan(project, "galley", "q.ghost"));
    const after = resolveAndSolve(layerMap(next), "galley");
    expect(after.diagnostics.some((d) => d.code === "set-missing-base")).toBe(false);
  });

  test("resolved statements delegate to delete (companions included)", () => {
    const project = fixture();
    const next = applyEdits(project, proposeDropOrphan(project, "galley", "k.north"));
    const p = resolveAndSolve(layerMap(next), "galley");
    expect(p.resolved.effective.has("k.north")).toBe(false);
    expect(p.resolved.effective.has("k.north.length")).toBe(false);
  });
});

describe("the killer demo", () => {
  test("measure the as-built → concept updates, designed changes intact, contradiction queued", () => {
    let project = loadProject(DEMO_FILES);

    // Field pass on the as-built: tape the kitchen.
    project = applyEdits(
      project,
      proposeMeasure(project, "asbuilt", { wall: "k.north" }, L("11'-8 1/2\""), "2026-07-09"),
    );
    project = applyEdits(
      project,
      proposeSetParam(project, "asbuilt", "k.depth", L("10'-1\""), "measured", "2026-07-09"),
    );

    // The as-built took the measurements as param promotions.
    const asbuilt = resolveAndSolve(layerMap(project), "asbuilt");
    expect(asbuilt.solution.contradictions).toEqual([]);
    expect(wallView(asbuilt, "k.north")!.lengthInches).toBeCloseTo(IN("11'-8 1/2\""), 3);

    // The concept inherited the depth correction live...
    const galley = resolveAndSolve(layerMap(project), "galley");
    expect(wallView(galley, "k.east")!.lengthInches).toBeCloseTo(IN("10'-1\""), 3);
    // ...its designed width is intact...
    expect(wallView(galley, "k.north")!.lengthInches).toBeCloseTo(IN("9'-6\""), 3);
    // ...and the width correction it masks is queued for review.
    const masked = galley.diagnostics.filter((d) => d.code === "masked-correction");
    expect(masked).toHaveLength(1);
    expect(masked[0]!.data).toMatchObject({ base: L("11'-8 1/2\"") });

    // Review the masked correction: keep the design, acknowledge the base.
    project = applyEdits(project, proposeResolveMasked(project, "galley", "k.width", "keep"));
    const galley2 = resolveAndSolve(layerMap(project), "galley");
    expect(galley2.diagnostics.filter((d) => d.code === "masked-correction")).toEqual([]);
    expect(wallView(galley2, "k.north")!.lengthInches).toBeCloseTo(IN("9'-6\""), 3);

    // Disagreeing tape checks inside the concept (a single tape only drifts a
    // designed value — two hard reads that can't both hold contradict):
    // queued there, invisible to the as-built.
    project = applyEdits(
      project,
      proposeMeasure(project, "galley", { a: "k.sw", b: "k.se" }, L("10'-0\"")),
    );
    project = applyEdits(
      project,
      proposeMeasure(project, "galley", { a: "k.nw", b: "k.ne" }, L("10'-6\"")),
    );
    const galley3 = resolveAndSolve(layerMap(project), "galley");
    expect(galley3.solution.contradictions.length).toBeGreaterThan(0);
    expect(resolveAndSolve(layerMap(project), "asbuilt").solution.contradictions).toEqual([]);
  });
});
