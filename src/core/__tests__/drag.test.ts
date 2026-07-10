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

  test("drag against a measured width (depth still free): refusal citing the blocker", () => {
    const measured = BASE.replace(`12'-0" [approximated]`, `12'-0" [measured 2026-07-02]`).replace(
      `10'-0" [measured 2026-07-01]`,
      `10'-0" [approximated]`,
    );
    const project = loadProject({ "asbuilt.abl": measured });
    // pure-east drag: the free depth can't explain it, the measured width won't
    const proposal = proposeMove(project, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("refusal");
    if (proposal.kind !== "refusal") return;
    expect(proposal.blockers).toContain("k.width");
  });

  test("fully measured room: a corner drag translates it, measurements untouched", () => {
    const measured = BASE.replace(`12'-0" [approximated]`, `12'-0" [measured 2026-07-02]`);
    const project = loadProject({ "asbuilt.abl": measured });
    const proposal = proposeMove(project, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("room-move");
    if (proposal.kind !== "room-move") return;
    expect(proposal.room).toBe("k");
    expect(proposal.verified).toBe(true);
    // the room's at: is rewritten; both measured params survive verbatim
    const next = applyEdits(project, proposal.edits);
    const text = next.files.get("asbuilt.abl")!;
    expect(text).toContain(`room k : rect(k.width, k.depth) { at: ~(6", 0") }`);
    expect(text).toContain(`param k.width = 12'-0" [measured 2026-07-02]`);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(junctionPos(p.solution, "k.ne")!.x).toBeCloseTo(IN(`12'-6"`), 1);
  });

  test("dragging the at:-corner moves the room even when a dimension is free", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    const proposal = proposeMove(project, "asbuilt", "k.sw", {
      x: s64FromFeet(2),
      y: s64FromFeet(1),
    });
    expect(proposal.kind).toBe("room-move");
    if (proposal.kind !== "room-move") return;
    const next = applyEdits(project, proposal.edits);
    expect(next.files.get("asbuilt.abl")!).toContain(
      `room k : rect(k.width, k.depth) { at: ~(2'-0", 1'-0") }`,
    );
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
    // and now the same drag can only mean "move the room"
    const proposal = proposeMove(next, "asbuilt", "k.ne", {
      x: s64FromFeet(12.5),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("room-move");
  });

  test("authored loop (no template): measured-bound corner drag refuses and changes nothing", () => {
    // Regression: without a gauge anchor, every param has phantom sensitivity
    // to every junction and a drag can invert through it (browser-found bug:
    // dragging dl.ne rewrote dl.south_width 12' -> 19'-6").
    const L = `layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }

param dl.depth = 13'-0" [measured]
param dl.east_depth = 8'-0" [measured]
param dl.south_width = 12'-0" [approximated]
param dl.width = 20'-0" [measured]

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
    const project = loadProject({ "asbuilt.abl": L });
    const before = project.files.get("asbuilt.abl");
    const proposal = proposeMove(project, "asbuilt", "dl.ne", {
      x: s64FromFeet(18),
      y: s64FromFeet(13),
    });
    expect(proposal.kind).toBe("refusal");
    expect(project.files.get("asbuilt.abl")).toBe(before);
    // the south wall's free end is dl.s (dl.sw is pinned by the measured
    // width through the west wall); dragging it edits south_width, with the
    // unbound jog absorbing the change
    const ok = proposeMove(project, "asbuilt", "dl.s", {
      x: s64FromFeet(12.5),
      y: 0,
    });
    expect(ok.kind).toBe("param-edit");
    if (ok.kind !== "param-edit") return;
    expect(ok.param).toBe("dl.south_width");
    expect(ok.newValue).toBe(parseLength(`12'-6"`));
    expect(ok.verified).toBe(true);
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
