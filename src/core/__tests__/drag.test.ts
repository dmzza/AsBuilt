import { describe, expect, test } from "vitest";
import { applyEdits, layerMap, loadProject, proposeMove, proposeSetParam } from "../editkit";
import { resolveAndSolve, wallView } from "../model";
import { junctionPos } from "../solve";
import { parseLength, s64FromFeet } from "../units";

const IN = (s: string): number => parseLength(s) / 64;

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)

junction lonely ~(30'-0", 4'-0")
`;

const CONCEPT = `layer galley : asbuilt
`;

describe("(d) drag rules produce deterministic text edits", () => {
  test("drag k.ne east 6\": edits the free width param, verified", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const proposal = proposeMove(project, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("param-edit");
    if (proposal.kind !== "param-edit") return;
    expect(proposal.param).toBe("k.width");
    expect(proposal.newValue).toBe(parseLength(`12'-6"`));
    expect(proposal.verified).toBe(true);
    expect(proposal.edits).toHaveLength(1);
    expect(proposal.edits[0]!.kind).toBe("replace-line");
    if (proposal.edits[0]!.kind !== "replace-line") return;
    expect(proposal.edits[0]!.newText).toBe(`param k.width = 12'-6" [approximated]`);

    // applying really moves both walls
    const next = applyEdits(project, proposal.edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`12'-6"`), 2);
    expect(wallView(p, "k.south")!.lengthInches).toBeCloseTo(IN(`12'-6"`), 2);
  });

  test("drag against a measured width: refusal citing the blocker", () => {
    const measured = BASE.replace(`12'-0" [approximated]`, `12'-0" [measured 2026-07-02]`);
    const project = loadProject({ "asbuilt.abl": measured });
    const proposal = proposeMove(project, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("refusal");
    if (proposal.kind !== "refusal") return;
    expect(proposal.blockers).toContain("k.width");
  });

  test("drag an unconstrained junction: rewrites its sketch line", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const proposal = proposeMove(project, "asbuilt", "lonely", {
      x: s64FromFeet(31),
      y: s64FromFeet(5),
    });
    expect(proposal.kind).toBe("sketch-edit");
    if (proposal.kind !== "sketch-edit") return;
    expect(proposal.verified).toBe(true);
    expect(proposal.edits).toHaveLength(1);
    if (proposal.edits[0]!.kind !== "replace-line") return;
    expect(proposal.edits[0]!.newText).toBe(`junction lonely ~(31'-0", 5'-0")`);
  });

  test("drag in a concept: appends a designed set with (was ...)", () => {
    const project = loadProject({
      "asbuilt.abl": BASE,
      "concepts/galley.abl": CONCEPT,
    });
    const proposal = proposeMove(project, "galley", "k.ne", {
      x: s64FromFeet(10),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("param-edit");
    if (proposal.kind !== "param-edit") return;
    expect(proposal.param).toBe("k.width");
    expect(proposal.verified).toBe(true);
    expect(proposal.edits[0]!.kind).toBe("append");
    if (proposal.edits[0]!.kind !== "append") return;
    expect(proposal.edits[0]!.file).toBe("concepts/galley.abl");
    expect(proposal.edits[0]!.lines).toEqual([
      `set k.width = 10'-0" [designed] (was 12'-0")`,
    ]);

    // concept sees 10'; asbuilt untouched at 12'
    const next = applyEdits(project, proposal.edits);
    const concept = resolveAndSolve(layerMap(next), "galley");
    expect(wallView(concept, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 2);
    const asbuilt = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(asbuilt, "k.north")!.lengthInches).toBeCloseTo(IN("12'"), 2);
  });

  test("measuring via proposeSetParam rewrites the param line in place", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const edits = proposeSetParam(
      project,
      "asbuilt",
      "k.width",
      parseLength(`11'-8 1/2"`),
      "measured",
      "2026-07-08",
    );
    expect(edits).toHaveLength(1);
    if (edits[0]!.kind !== "replace-line") return;
    expect(edits[0]!.newText).toBe(`param k.width = 11'-8 1/2" [measured 2026-07-08]`);

    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN(`11'-8 1/2"`), 2);
    // and now the same drag refuses
    const proposal = proposeMove(next, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("refusal");
  });

  test("the full loop: drag in concept, then measure the base, live inheritance holds", () => {
    const project = loadProject({
      "asbuilt.abl": BASE,
      "concepts/galley.abl": CONCEPT,
    });
    // 1. concept drags width to 10'
    const drag = proposeMove(project, "galley", "k.ne", {
      x: s64FromFeet(10),
      y: s64FromFeet(10),
    });
    expect(drag.kind).toBe("param-edit");
    if (drag.kind !== "param-edit") return;
    let world = applyEdits(project, drag.edits);

    // 2. as-built measures depth (a param the concept never touched)
    const measure = proposeSetParam(
      world,
      "asbuilt",
      "k.depth",
      parseLength(`9'-9"`),
      "measured",
      "2026-07-08",
    );
    world = applyEdits(world, measure);

    // 3. concept: width still its designed 10', depth follows the base
    const concept = resolveAndSolve(layerMap(world), "galley");
    expect(wallView(concept, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 2);
    expect(wallView(concept, "k.east")!.lengthInches).toBeCloseTo(IN(`9'-9"`), 2);
    expect(
      concept.diagnostics.filter((d) => d.code === "masked-correction"),
    ).toEqual([]);

    // 4. as-built corrects width under the concept's override -> flag fires
    const correct = proposeSetParam(
      world,
      "asbuilt",
      "k.width",
      parseLength(`11'-8 1/2"`),
      "measured",
      "2026-07-08",
    );
    world = applyEdits(world, correct);
    const flagged = resolveAndSolve(layerMap(world), "galley");
    const masked = flagged.diagnostics.filter((d) => d.code === "masked-correction");
    expect(masked).toHaveLength(1);
    expect(masked[0]!.key).toBe("k.width");
    // concept geometry still the designed 10'
    expect(wallView(flagged, "k.north")!.lengthInches).toBeCloseTo(IN("10'"), 2);
    // junction sanity: everything still solves
    expect(junctionPos(flagged.solution, "k.ne")).not.toBeNull();
  });
});
