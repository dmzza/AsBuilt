import { describe, expect, test } from "vitest";
import {
  applyEdits,
  layerMap,
  loadProject,
  proposeMove,
  proposeMoveWall,
  proposeSetParam,
} from "../editkit";
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

  test("diagonal drag updates width and depth together (multi-param)", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    // BASE: width approximated, depth measured — only width is free.
    // Soft both so the multi-param path can take both knobs.
    const soft = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [approximated]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;
    const p0 = loadProject({ "asbuilt.abl": soft });
    // NE from (12',10') → (14',12'): need +2' width and +2' depth
    const proposal = proposeMove(p0, "asbuilt", "k.ne", {
      x: s64FromFeet(14),
      y: s64FromFeet(12),
    });
    expect(proposal.kind).toBe("param-edit");
    if (proposal.kind !== "param-edit") return;
    // Multi-param names joined with +
    expect(proposal.param.includes("k.width") || proposal.edits.length >= 2).toBe(true);
    const next = applyEdits(p0, proposal.edits);
    const text = next.files.get("asbuilt.abl")!;
    expect(text).toMatch(/param k\.width = 14'/);
    expect(text).toMatch(/param k\.depth = 12'/);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("14'"), 1);
    expect(wallView(p, "k.east")!.lengthInches).toBeCloseTo(IN("12'"), 1);
    void project;
  });

  test("axis-aligned drag still uses a single param when it scores perfectly", () => {
    const soft = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [approximated]
param k.width = 12'-0" [approximated]

room k : rect(k.width, k.depth)
`;
    const p0 = loadProject({ "asbuilt.abl": soft });
    const proposal = proposeMove(p0, "asbuilt", "k.ne", {
      x: s64FromFeet(14),
      y: s64FromFeet(10),
    });
    expect(proposal.kind).toBe("param-edit");
    if (proposal.kind !== "param-edit") return;
    // Pure east: only width
    expect(proposal.param).toBe("k.width");
    expect(proposal.edits).toHaveLength(1);
    const next = applyEdits(p0, proposal.edits);
    expect(next.files.get("asbuilt.abl")).toMatch(/param k\.width = 14'/);
    expect(next.files.get("asbuilt.abl")).toMatch(/param k\.depth = 10'-0" \[approximated\]/);
  });

  test("drag wall: free width param moves both north endpoints", () => {
    const project = loadProject({ "asbuilt.abl": BASE });
    // Push the east wall further east by 1' (widens the room).
    const proposal = proposeMoveWall(project, "asbuilt", "k.east", { x: 12, y: 0 });
    expect(proposal.kind).not.toBe("refusal");
    if (proposal.kind === "refusal") return;
    expect(proposal.verified).toBe(true);
    const next = applyEdits(project, proposal.edits);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("13'"), 1);
  });

  test("forceBreak (⌥): lands near drop; demotes measured params; drops meases", () => {
    // Drag is not a tape reading: measured params become approximated, and
    // incident meases are removed (meas cannot demote provenance).
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured]
param k.width = 12'-0" [measured]

room k : rect(k.width, k.depth)

meas m_diag : dist(k.sw, k.ne) = 15'-7 1/2" [measured]
`;
    const project = loadProject({ "asbuilt.abl": src });
    expect(resolveAndSolve(layerMap(project), "asbuilt").solution.contradictions).toEqual(
      [],
    );

    const forced = proposeMove(
      project,
      "asbuilt",
      "k.ne",
      { x: s64FromFeet(14), y: s64FromFeet(12) },
      { forceBreak: true },
    );
    expect(forced.kind).not.toBe("refusal");
    if (forced.kind === "refusal") return;
    expect(forced.verified).toBe(true);
    expect(forced.broke).toEqual(expect.arrayContaining(["k.width", "k.depth", "m_diag"]));
    const next = applyEdits(project, forced.edits);
    const text = next.files.get("asbuilt.abl")!;
    expect(text).toMatch(/param k\.width = 14'-0" \[approximated\]/);
    expect(text).toMatch(/param k\.depth = 12'-0" \[approximated\]/);
    expect(text).not.toMatch(/meas m_diag/);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    const ne = junctionPos(p.solution, "k.ne")!;
    expect(ne.x).toBeCloseTo(IN("14'"), 0);
    expect(ne.y).toBeCloseTo(IN("12'"), 0);
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("14'"), 0);
    expect(wallView(p, "k.east")!.lengthInches).toBeCloseTo(IN("12'"), 0);
  });

  test("forceBreak wall drag demotes measured width to approximated", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured]
param k.width = 12'-0" [measured]

room k : rect(k.width, k.depth)
`;
    const project = loadProject({ "asbuilt.abl": src });
    const forced = proposeMoveWall(
      project,
      "asbuilt",
      "k.east",
      { x: 24, y: 0 },
      { forceBreak: true },
    );
    expect(forced.kind).not.toBe("refusal");
    if (forced.kind === "refusal") return;
    const next = applyEdits(project, forced.edits);
    const text = next.files.get("asbuilt.abl")!;
    expect(text).toMatch(/param k\.width = .*\[approximated\]/);
    expect(text).not.toMatch(/param k\.width = .*\[measured/);
    const p = resolveAndSolve(layerMap(next), "asbuilt");
    expect(wallView(p, "k.north")!.lengthInches).toBeCloseTo(IN("14'"), 1);
    // Effective provenance after resolve must not be measured
    const w = p.resolved.effective.get("k.width");
    expect(w?.stmt.kind === "param" || w?.stmt.kind === "set").toBe(true);
    if (w?.stmt.kind === "param" || w?.stmt.kind === "set") {
      expect(w.stmt.prov).toBe("approximated");
    }
  });

  test("dragging a neighbor wall invalidates a measured free-wall centerline", () => {
    // W1 measured via meas; drag dl.jog moves shared junction so W1 length
    // no longer matches the tape — meas must be dropped / grade not measured.
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

junction a ~(0", 0")
junction b ~(8'-0", 0")
junction c ~(0", 4'-0")

wall jog { from: a, to: b, type: int_2x4 }
wall w11 { from: a, to: c, type: int_2x4 }

axis jog h
axis w11 v

meas m_w11 : dist(a, c) = 4'-0" [measured]
`;
    let project = loadProject({ "asbuilt.abl": src });
    let p = resolveAndSolve(layerMap(project), "asbuilt");
    expect(wallView(p, "w11")!.lengthInches).toBeCloseTo(IN("4'"), 2);

    // Move jog's `a` end north by dragging the wall (and/or endpoint motion).
    const drag = proposeMove(project, "asbuilt", "a", {
      x: 0,
      y: s64FromFeet(1),
    });
    expect(drag.kind).not.toBe("refusal");
    if (drag.kind === "refusal") return;
    project = applyEdits(project, drag.edits);
    p = resolveAndSolve(layerMap(project), "asbuilt");
    // Stale measured span must not remain — endpoint moved under the tape.
    expect(p.resolved.effective.has("m_w11")).toBe(false);
    expect(project.files.get("asbuilt.abl")).not.toMatch(/meas m_w11/);
    // w11 length is free now (no hard 4' claim)
    expect(wallView(p, "w11")!.lengthInches).toBeCloseTo(IN("3'"), 1);
  });

  test("invariant: no drag edit may leave a changed param still [measured]", () => {
    const src = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured]
param k.width = 12'-0" [measured]

room k : rect(k.width, k.depth)

meas m_diag : dist(k.sw, k.ne) = 15'-7 1/2" [measured]
`;
    const project = loadProject({ "asbuilt.abl": src });
    const before = new Map(
      [...resolveAndSolve(layerMap(project), "asbuilt").resolved.effective]
        .filter(([, e]) => e.stmt.kind === "param" || e.stmt.kind === "set")
        .map(([k, e]) => {
          const s = e.stmt as { value: number; prov: string };
          return [k, { value: s.value, prov: s.prov }] as const;
        }),
    );
    for (const forceBreak of [false, true]) {
      for (const delta of [
        { x: 24, y: 0 },
        { x: 0, y: 12 },
        { x: 18, y: 18 },
      ]) {
        const prop = proposeMoveWall(project, "asbuilt", "k.east", delta, {
          forceBreak,
        });
        if (prop.kind === "refusal" || prop.edits.length === 0) continue;
        const next = applyEdits(project, prop.edits);
        const after = resolveAndSolve(layerMap(next), "asbuilt");
        for (const [key, was] of before) {
          if (was.prov !== "measured") continue;
          const eff = after.resolved.effective.get(key);
          if (eff?.stmt.kind !== "param" && eff?.stmt.kind !== "set") continue;
          if (eff.stmt.value === was.value) continue;
          // Value changed → must not still claim measured
          expect(
            eff.stmt.prov,
            `${key} changed under forceBreak=${forceBreak} delta=${JSON.stringify(delta)}`,
          ).not.toBe("measured");
        }
      }
    }
  });
});
