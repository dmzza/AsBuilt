import {
  stmtKey,
  type AxisStmt,
  type FaceEnd,
  type FaceRef,
  type FixtureStmt,
  type JunctionStmt,
  type MeasStmt,
  type OpeningStmt,
  type ParamStmt,
  type ParsedLayer,
  type Point,
  type RoomRectStmt,
  type SetStmt,
  type WallStmt,
} from "./ast";
import { normalizeFaceRef } from "./faces";
import { resolve } from "./merge";
import { perturbParam, resolveAndSolve, type Pipeline } from "./model";
import { parseLayerFile } from "./parser";
import { printStmt } from "./printer";
import { buildSystem, junctionPos, solve } from "./solve";
import { s64FromInches, type S64 } from "./units";

/**
 * The drag rules (from the plan):
 *  1. A drag on geometry bound to a free (approximated/designed) param edits
 *     that param's statement.
 *  2. A drag on under-constrained geometry rewrites the junction's ~ sketch.
 *  3. measured values never change from a drag: refusal, citing blockers.
 *  4. Every GUI action is a deterministic text edit to the current layer file.
 */

export interface Project {
  files: Map<string, string>;
  layers: Map<string, { file: string; parsed: ParsedLayer }>;
}

export function loadProject(files: Record<string, string>): Project {
  const fileMap = new Map(Object.entries(files));
  const layers = new Map<string, { file: string; parsed: ParsedLayer }>();
  for (const [file, text] of fileMap) {
    const parsed = parseLayerFile(file, text);
    if (layers.has(parsed.header.name)) {
      throw new Error(`duplicate layer "${parsed.header.name}"`);
    }
    layers.set(parsed.header.name, { file, parsed });
  }
  return { files: fileMap, layers };
}

export function layerMap(project: Project): Map<string, ParsedLayer> {
  const out = new Map<string, ParsedLayer>();
  for (const [name, l] of project.layers) out.set(name, l.parsed);
  return out;
}

export type TextEdit =
  | { kind: "replace-line"; file: string; line: number; newText: string }
  | { kind: "append"; file: string; lines: string[] };

export function applyEdits(project: Project, edits: TextEdit[]): Project {
  const files = new Map(project.files);
  for (const edit of edits) {
    const text = files.get(edit.file);
    if (text === undefined) throw new Error(`no file "${edit.file}"`);
    const lines = text.split("\n");
    if (edit.kind === "replace-line") {
      if (edit.line < 1 || edit.line > lines.length) {
        throw new Error(`bad line ${edit.line} in ${edit.file}`);
      }
      lines[edit.line - 1] = edit.newText;
    } else {
      // append before a single trailing empty line, if present
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(...edit.lines, "");
    }
    files.set(edit.file, lines.join("\n"));
  }
  return loadProject(Object.fromEntries(files));
}

export type MoveProposal =
  | {
      kind: "param-edit";
      param: string;
      newValue: S64;
      edits: TextEdit[];
      verified: boolean;
    }
  | { kind: "sketch-edit"; junction: string; edits: TextEdit[]; verified: boolean }
  | { kind: "room-move"; room: string; edits: TextEdit[]; verified: boolean }
  | { kind: "refusal"; blockers: string[]; message: string };

const SENS_TOL = 0.05; // inches response to 1" param shift
const VERIFY_TOL = 0.25; // inches from target after applying the edit

interface Sens {
  param: string;
  prov: string;
  sx: number;
  sy: number;
}

function sensitivities(pipeline: Pipeline, junction: string): Sens[] {
  const cur = junctionPos(pipeline.solution, junction);
  if (cur === null) return [];
  const out: Sens[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    const sol = perturbParam(pipeline, key, 1);
    const moved = junctionPos(sol, junction);
    if (moved === null) continue;
    out.push({
      param: key,
      prov: eff.stmt.prov,
      sx: moved.x - cur.x,
      sy: moved.y - cur.y,
    });
  }
  return out;
}

function verifyMove(
  project: Project,
  edits: TextEdit[],
  branch: string,
  junction: string,
  target: { x: number; y: number },
): boolean {
  try {
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), branch);
    const pos = junctionPos(p.solution, junction);
    if (pos === null) return false;
    return Math.hypot(pos.x - target.x, pos.y - target.y) <= VERIFY_TOL;
  } catch {
    return false;
  }
}

/**
 * Propose the text edit implied by dragging `junction` to `target` (s64 coords)
 * while `branch` is checked out.
 */
export function proposeMove(
  project: Project,
  branch: string,
  junction: string,
  target: { x: S64; y: S64 },
): MoveProposal {
  const layers = layerMap(project);
  const pipeline = resolveAndSolve(layers, branch);
  const cur = junctionPos(pipeline.solution, junction);
  if (cur === null) {
    return { kind: "refusal", blockers: [], message: `unknown junction "${junction}"` };
  }
  const targetIn = { x: target.x / 64, y: target.y / 64 };
  const delta = { x: targetIn.x - cur.x, y: targetIn.y - cur.y };
  const deltaMag = Math.hypot(delta.x, delta.y);
  if (deltaMag < 1 / 64) {
    return { kind: "sketch-edit", junction, edits: [], verified: true };
  }

  const sens = sensitivities(pipeline, junction);
  const free = sens.filter(
    (s) => s.prov !== "measured" && Math.hypot(s.sx, s.sy) > SENS_TOL,
  );

  // Candidate params, best explained fraction first; verification decides.
  const candidates = free
    .map((s) => {
      const ss = s.sx * s.sx + s.sy * s.sy;
      const dp = (s.sx * delta.x + s.sy * delta.y) / ss;
      const rx = delta.x - dp * s.sx;
      const ry = delta.y - dp * s.sy;
      return { s, dp, explained: 1 - Math.hypot(rx, ry) / deltaMag };
    })
    .filter((c) => c.explained > 0.3 && Math.abs(c.dp) > 1 / 128)
    .sort((a, b) => b.explained - a.explained);

  for (const cand of candidates) {
    const eff = pipeline.resolved.effective.get(cand.s.param)!;
    const stmt = eff.stmt as ParamStmt | SetStmt;
    const newValue = stmt.value + s64FromInches(cand.dp);
    const owner = project.layers.get(eff.layer);
    if (owner === undefined) continue;
    let edits: TextEdit[];
    if (eff.layer === branch) {
      const updated = { ...stmt, value: newValue };
      edits = [
        {
          kind: "replace-line",
          file: owner.file,
          line: stmt.loc.line,
          newText: printStmt(updated),
        },
      ];
    } else {
      // Override in the current branch. In a concept, a drag expresses
      // design intent; in the as-built root a drag refines a sketch guess.
      const isRoot = project.layers.get(branch)!.parsed.header.parent === null;
      const setStmt: SetStmt = {
        kind: "set",
        name: cand.s.param,
        value: newValue,
        prov: isRoot ? stmt.prov : "designed",
        was: stmt.value,
        loc: { file: "", line: 0 },
        leadingComments: [],
      };
      edits = [
        {
          kind: "append",
          file: project.layers.get(branch)!.file,
          lines: [printStmt(setStmt)],
        },
      ];
    }
    // An edit that doesn't land the junction where the user dropped it is
    // not the user's intent: reject and try the next strategy.
    if (verifyMove(project, edits, branch, junction, targetIn)) {
      return { kind: "param-edit", param: cand.s.param, newValue, edits, verified: true };
    }
  }

  // Translating a rect room: dragging its at:-corner (sw) moves the room by
  // rewriting `at:`. Any corner works when the room's dimensions offer no
  // freedom at this junction (fully measured room = rigid; a drag can only
  // mean "put it somewhere else"). Params were tried first, so a resize
  // reading of the drag always wins over a translate reading.
  const jEff = pipeline.resolved.effective.get(junction);
  if (jEff?.expandedFrom !== undefined) {
    const roomKey = jEff.expandedFrom;
    const roomEff = pipeline.resolved.effective.get(roomKey);
    if (
      roomEff?.stmt.kind === "room" &&
      (junction === `${roomKey}.sw` || free.length === 0)
    ) {
      const rs = roomEff.stmt;
      const updated: RoomRectStmt = {
        ...rs,
        at: {
          x: (rs.at?.x ?? 0) + s64FromInches(delta.x),
          y: (rs.at?.y ?? 0) + s64FromInches(delta.y),
        },
      };
      const owner = project.layers.get(roomEff.layer);
      if (owner !== undefined) {
        const edits: TextEdit[] =
          roomEff.layer === branch
            ? [
                {
                  kind: "replace-line",
                  file: owner.file,
                  line: rs.loc.line,
                  newText: printStmt(updated),
                },
              ]
            : [
                {
                  kind: "append",
                  file: project.layers.get(branch)!.file,
                  lines: [printStmt(updated)],
                },
              ];
        if (verifyMove(project, edits, branch, junction, targetIn)) {
          return { kind: "room-move", room: roomKey, edits, verified: true };
        }
      }
    }
  }

  // No free param explains the drag. Sketch-dominated?
  const probe = buildSystem(pipeline.resolved, {
    anchors: pipeline.anchors,
    sketchOverride: new Map([[junction, targetIn]]),
  });
  const probeSol = solve(probe, pipeline.solution.x);
  const probePos = junctionPos(probeSol, junction)!;
  if (Math.hypot(probePos.x - targetIn.x, probePos.y - targetIn.y) <= VERIFY_TOL) {
    const eff = pipeline.resolved.effective.get(junction)!;
    const stmt = eff.stmt as JunctionStmt;
    const updated: JunctionStmt = { ...stmt, sketch: { x: target.x, y: target.y } };
    const owner = project.layers.get(eff.layer)!;
    const edits: TextEdit[] =
      eff.layer === branch && eff.expandedFrom === undefined
        ? [
            {
              kind: "replace-line",
              file: owner.file,
              line: stmt.loc.line,
              newText: printStmt(updated),
            },
          ]
        : [
            {
              kind: "append",
              file: project.layers.get(branch)!.file,
              lines: [printStmt(updated)],
            },
          ];
    if (verifyMove(project, edits, branch, junction, targetIn)) {
      return { kind: "sketch-edit", junction, edits, verified: true };
    }
  }

  // Locked. Cite what binds it.
  const blockers = new Set<string>();
  for (const s of sens) {
    if (s.prov === "measured" && Math.hypot(s.sx, s.sy) > SENS_TOL) blockers.add(s.param);
  }
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "meas" && (eff.stmt.a === junction || eff.stmt.b === junction)) {
      blockers.add(key);
    } else if (
      eff.stmt.kind === "stack" &&
      (eff.stmt.a === junction || eff.stmt.b === junction)
    ) {
      blockers.add(key);
    }
  }
  const roomHint =
    jEff?.expandedFrom !== undefined
      ? ` (drag ${jEff.expandedFrom}.sw to move the room)`
      : "";
  return {
    kind: "refusal",
    blockers: [...blockers].sort(),
    message:
      blockers.size > 0
        ? `locked by ${[...blockers].sort().join(", ")}`
        : `no free parameter or sketch explains this drag${roomHint}`,
  };
}

/** Smallest unused `<prefix><n>` name across all layers' authored statements. */
export function genName(project: Project, prefix: string): string {
  const used = new Set<string>();
  for (const [, l] of project.layers) {
    for (const s of l.parsed.stmts) {
      const key = stmtKey(s);
      if (key !== null) used.add(key);
    }
  }
  for (let n = 1; ; n++) {
    const candidate = `${prefix}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type WallEndpoint = { x: S64; y: S64 } | { existing: string };

export interface AddWallProposal {
  edits: TextEdit[];
  wall: string;
  junctions: string[];
}

/**
 * Draw a wall: new junctions for free endpoints, reuse for `existing` ones
 * (shared walls emerge by drawing against existing junctions). An `axis`
 * constraint is emitted when the UI snapped the wall to an axis.
 */
export function proposeAddWall(
  project: Project,
  branch: string,
  args: {
    a: WallEndpoint;
    b: WallEndpoint;
    wallType: string;
    axis?: "h" | "v";
    /** Level namespace: names are generated under `<ns>.` (drawn on that level). */
    ns?: string;
  },
): AddWallProposal {
  const file = project.layers.get(branch);
  if (file === undefined) throw new Error(`no layer "${branch}"`);
  const lines: string[] = [];
  const created: string[] = [];
  const junctionNames: string[] = [];
  let counter = 0;
  const p = args.ns !== undefined ? `${args.ns}.` : "";
  const jPrefix = `${p}j`;
  const wPrefix = `${p}w`;

  for (const end of [args.a, args.b]) {
    if ("existing" in end) {
      junctionNames.push(end.existing);
    } else {
      // genName scans authored statements only; bump past what we just made
      let name = genName(project, jPrefix);
      while (created.includes(name)) {
        counter += 1;
        name = `${jPrefix}${parseInt(name.slice(jPrefix.length), 10) + counter}`;
      }
      created.push(name);
      junctionNames.push(name);
      const j: JunctionStmt = {
        kind: "junction",
        name,
        sketch: { x: end.x, y: end.y },
        loc: { file: "", line: 0 },
        leadingComments: [],
      };
      lines.push(printStmt(j));
    }
  }

  let wallName = genName(project, wPrefix);
  while (created.includes(wallName)) {
    wallName = `${wPrefix}${parseInt(wallName.slice(wPrefix.length), 10) + 1}`;
  }
  const wall: WallStmt = {
    kind: "wall",
    name: wallName,
    from: junctionNames[0]!,
    to: junctionNames[1]!,
    wallType: args.wallType,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  lines.push(printStmt(wall));

  if (args.axis !== undefined) {
    const axis: AxisStmt = {
      kind: "axis",
      name: `${wallName}.axis`,
      wall: wallName,
      orient: args.axis,
      loc: { file: "", line: 0 },
      leadingComments: [],
    };
    lines.push(printStmt(axis));
  }

  return {
    edits: [{ kind: "append", file: file.file, lines }],
    wall: wallName,
    junctions: junctionNames,
  };
}

/**
 * Delete an element. Own authored lines are blanked; inherited or
 * template-expanded statements get tombstones. Deleting a wall also removes
 * its companion `.length`/`.axis` statements so no dangling refs remain.
 */
export function proposeDelete(project: Project, branch: string, key: string): TextEdit[] {
  const resolved = resolve(layerMap(project), branch);
  const targets = [key, `${key}.length`, `${key}.axis`].filter((k) =>
    resolved.effective.has(k),
  );
  if (targets.length === 0) throw new Error(`nothing to delete at "${key}"`);

  // If deleting a junction, also delete all walls that reference it
  const eff = resolved.effective.get(key);
  if (eff?.stmt.kind === "junction") {
    for (const [wallKey, wallEff] of resolved.effective) {
      if (wallEff.stmt.kind === "wall") {
        if (wallEff.stmt.from === key || wallEff.stmt.to === key) {
          // Add the wall and its companions to targets
          for (const k of [wallKey, `${wallKey}.length`, `${wallKey}.axis`]) {
            if (resolved.effective.has(k) && !targets.includes(k)) {
              targets.push(k);
            }
          }
        }
      }
    }
  }

  // If deleting a wall, also delete all openings hosted on it
  if (eff?.stmt.kind === "wall") {
    for (const [openingKey, openingEff] of resolved.effective) {
      if (openingEff.stmt.kind === "opening" && openingEff.stmt.wall === key) {
        if (!targets.includes(openingKey)) {
          targets.push(openingKey);
        }
      }
    }
  }

  const edits: TextEdit[] = [];
  const tombstones: string[] = [];
  for (const t of targets) {
    const targetEff = resolved.effective.get(t)!;
    if (targetEff.expandedFrom === undefined && targetEff.layer === branch) {
      edits.push({
        kind: "replace-line",
        file: project.layers.get(branch)!.file,
        line: targetEff.stmt.loc.line,
        newText: "",
      });
    } else {
      tombstones.push(`delete ${t}`);
    }
  }
  if (tombstones.length > 0) {
    edits.push({
      kind: "append",
      file: project.layers.get(branch)!.file,
      lines: tombstones,
    });
  }
  return edits;
}

export type MeasureTarget = { wall: string } | { a: string; b: string };

/**
 * Record a tape measurement.
 *
 * **Centerline** (default, or `ref: centerline`): measuring a wall whose length
 * is bound to a single param promotes THAT param to measured (define-once).
 * Anything else appends a `meas`.
 *
 * **Face-referenced** (`inner` / `outer` / mixed ends): NEVER freezes a derived
 * centerline into a param — that would bake a thickness assumption into a
 * "measured" value nobody taped. Always appends a `meas` with `{ ref: … }`;
 * the solver owns centerline via the face residual + thickness targets.
 */
export function proposeMeasure(
  project: Project,
  branch: string,
  target: MeasureTarget,
  value: S64,
  date?: string,
  ref?: FaceEnd | FaceRef,
): TextEdit[] {
  const face = normalizeFaceRef(ref);
  const pipeline = resolveAndSolve(layerMap(project), branch);
  let pair: { a: string; b: string };
  if ("wall" in target) {
    const wallEff = pipeline.resolved.effective.get(target.wall);
    if (wallEff?.stmt.kind !== "wall") throw new Error(`no wall "${target.wall}"`);
    // Param promotion only for centerline reads of a single-param binding.
    if (face === undefined) {
      const binding = pipeline.resolved.effective.get(`${target.wall}.length`);
      if (binding?.stmt.kind === "length") {
        const terms = binding.stmt.expr.terms;
        const first = terms[0];
        if (terms.length === 1 && first !== undefined && first.kind === "ref" && first.sign === 1) {
          return proposeSetParam(project, branch, first.name, value, "measured", date);
        }
      }
    }
    pair = { a: wallEff.stmt.from, b: wallEff.stmt.to };
  } else {
    pair = target;
  }
  const name = genName(project, "m");
  const meas: MeasStmt = {
    kind: "meas",
    name,
    a: pair.a,
    b: pair.b,
    value,
    date,
    ref: face,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  return [
    { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(meas)] },
  ];
}

export const OPENING_DEFAULTS = {
  door: { width: 32 * 64, height: 80 * 64 }, // 2'-8" x 6'-8"
  window: { width: 36 * 64, height: 36 * 64, sill: 30 * 64 }, // 3' x 3', sill 2'-6"
} as const;

/**
 * Place a door/window in a wall at a point along it (inches from the wall's
 * `from` end). The anchor is the nearer endpoint — offsets stay short and
 * survive far-end corrections. Offset is to the near jamb, rounded to 1".
 */
export function proposeAddOpening(
  project: Project,
  branch: string,
  args: {
    wall: string;
    opKind: "door" | "window";
    /** Desired center position along the wall, inches from its `from` end. */
    centerAlong: number;
    width?: S64;
    height?: S64;
    sill?: S64;
  },
): { edits: TextEdit[]; name: string } {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const wallEff = pipeline.resolved.effective.get(args.wall);
  if (wallEff?.stmt.kind !== "wall") throw new Error(`no wall "${args.wall}"`);
  const a = pipeline.resolved.effective.get(wallEff.stmt.from);
  const b = pipeline.resolved.effective.get(wallEff.stmt.to);
  if (a?.stmt.kind !== "junction" || b?.stmt.kind !== "junction") {
    throw new Error(`wall "${args.wall}" has unresolved endpoints`);
  }
  const defaults = OPENING_DEFAULTS[args.opKind];
  const width = args.width ?? defaults.width;
  const widthIn = width / 64;

  // wall length from the solved model
  const pa = pipelineJunction(pipeline, wallEff.stmt.from);
  const pb = pipelineJunction(pipeline, wallEff.stmt.to);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (widthIn > len) throw new Error(`opening wider than wall (${Math.round(len)}")`);

  let startIn = Math.min(Math.max(args.centerAlong - widthIn / 2, 0), len - widthIn);
  startIn = Math.round(startIn);

  // anchor at the nearer end
  const fromNearer = startIn + widthIn / 2 <= len / 2;
  const anchor = fromNearer ? wallEff.stmt.from : wallEff.stmt.to;
  const offsetIn = fromNearer ? startIn : Math.round(len - startIn - widthIn);

  const name = genName(project, args.opKind === "door" ? "d" : "win");
  const stmt: OpeningStmt = {
    kind: "opening",
    opKind: args.opKind,
    name,
    wall: args.wall,
    anchor,
    offset: { terms: [{ sign: 1, kind: "lit", value: s64FromInches(offsetIn) }] },
    width,
    height: args.height ?? defaults.height,
    sill:
      args.opKind === "window"
        ? args.sill ?? (defaults as { sill: S64 }).sill
        : args.sill,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  return {
    edits: [
      { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(stmt)] },
    ],
    name,
  };
}

function pipelineJunction(pipeline: Pipeline, name: string): { x: number; y: number } {
  const xi = pipeline.solution.system.varIndex.get(`j:${name}:x`);
  const yi = pipeline.solution.system.varIndex.get(`j:${name}:y`);
  if (xi === undefined || yi === undefined) throw new Error(`no junction "${name}"`);
  return { x: pipeline.solution.x[xi]!, y: pipeline.solution.x[yi]! };
}

/** Slide an opening along its wall: rewrite its offset (from its anchor). */
export function proposeSetOpeningOffset(
  project: Project,
  branch: string,
  name: string,
  offset: S64,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "opening") throw new Error(`no opening "${name}"`);
  const updated: OpeningStmt = {
    ...eff.stmt,
    offset: { terms: [{ sign: 1, kind: "lit", value: offset }] },
  };
  return replaceOrShadow(project, branch, eff.layer, eff.expandedFrom, eff.stmt.loc.line, updated);
}

/** Place a free-standing fixture box. */
export function proposeAddFixture(
  project: Project,
  branch: string,
  args: { at: Point; fixKind?: string; w?: S64; d?: S64; ns?: string },
): { edits: TextEdit[]; name: string } {
  const name = genName(project, args.ns !== undefined ? `${args.ns}.f` : "f");
  const stmt: FixtureStmt = {
    kind: "fixture",
    name,
    fixKind: args.fixKind ?? "fixture",
    at: args.at,
    w: args.w ?? 24 * 64,
    d: args.d ?? 24 * 64,
    rot: 0,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  return {
    edits: [
      { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(stmt)] },
    ],
    name,
  };
}

/** Update a fixture's position/rotation/kind/size. */
export function proposeSetFixture(
  project: Project,
  branch: string,
  name: string,
  updates: Partial<Pick<FixtureStmt, "at" | "rot" | "fixKind" | "w" | "d">>,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "fixture") throw new Error(`no fixture "${name}"`);
  const updated: FixtureStmt = { ...eff.stmt, ...updates };
  return replaceOrShadow(project, branch, eff.layer, eff.expandedFrom, eff.stmt.loc.line, updated);
}

/** Change a wall's type (thickness follows the walltype). */
export function proposeSetWallType(
  project: Project,
  branch: string,
  name: string,
  wallType: string,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "wall") throw new Error(`no wall "${name}"`);
  if (pipeline.resolved.effective.get(wallType)?.stmt.kind !== "walltype") {
    throw new Error(`no walltype "${wallType}"`);
  }
  const updated: WallStmt = { ...eff.stmt, wallType };
  return replaceOrShadow(project, branch, eff.layer, eff.expandedFrom, eff.stmt.loc.line, updated);
}

/** Update an opening's width/height/sill. */
export function proposeSetOpening(
  project: Project,
  branch: string,
  name: string,
  updates: Partial<Pick<OpeningStmt, "width" | "height" | "sill">>,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "opening") throw new Error(`no opening "${name}"`);
  const updated: OpeningStmt = { ...eff.stmt, ...updates };
  return replaceOrShadow(project, branch, eff.layer, eff.expandedFrom, eff.stmt.loc.line, updated);
}

/** In-place rewrite when the branch owns the authored line, shadow otherwise. */
function replaceOrShadow(
  project: Project,
  branch: string,
  ownerLayer: string,
  expandedFrom: string | undefined,
  line: number,
  updated: OpeningStmt | FixtureStmt | WallStmt,
): TextEdit[] {
  if (ownerLayer === branch && expandedFrom === undefined) {
    return [
      {
        kind: "replace-line",
        file: project.layers.get(ownerLayer)!.file,
        line,
        newText: printStmt(updated),
      },
    ];
  }
  return [
    { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(updated)] },
  ];
}

/** Change an existing meas value (in place if owned, shadowed if inherited). */
export function proposeEditMeas(
  project: Project,
  branch: string,
  name: string,
  value: S64,
  date?: string,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "meas") throw new Error(`no meas "${name}"`);
  const updated: MeasStmt = { ...eff.stmt, value, date: date ?? eff.stmt.date };
  if (eff.layer === branch && eff.expandedFrom === undefined) {
    return [
      {
        kind: "replace-line",
        file: project.layers.get(eff.layer)!.file,
        line: eff.stmt.loc.line,
        newText: printStmt(updated),
      },
    ];
  }
  return [
    { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(updated)] },
  ];
}

/** Create a new concept layer file branching from `parent`. */
export function createConcept(project: Project, name: string, parent: string): Project {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`bad concept name "${name}" (lowercase identifier)`);
  }
  if (project.layers.has(name)) throw new Error(`layer "${name}" already exists`);
  if (!project.layers.has(parent)) throw new Error(`unknown parent "${parent}"`);
  const file = `concepts/${name}.abl`;
  if (project.files.has(file)) throw new Error(`file "${file}" already exists`);
  const files = Object.fromEntries(project.files);
  files[file] = `layer ${name} : ${parent}\n`;
  return loadProject(files);
}

/**
 * Re-parent `branch` onto `newParent` by rewriting the layer header line.
 * That IS the rebase — the next resolve re-merges, re-checks, re-solves.
 * Cycles (new parent descends from `branch`) are rejected here rather than
 * left to surface as the resolver's runtime cycle error.
 */
export function proposeReparent(
  project: Project,
  branch: string,
  newParent: string,
): TextEdit[] {
  const target = project.layers.get(branch);
  if (target === undefined) throw new Error(`no layer "${branch}"`);
  if (target.parsed.header.parent === null) {
    throw new Error(`"${branch}" is the as-built root; it has no parent to change`);
  }
  if (newParent === branch) throw new Error(`cannot parent "${branch}" to itself`);
  if (!project.layers.has(newParent)) throw new Error(`unknown parent "${newParent}"`);
  if (target.parsed.header.parent === newParent) return [];
  const seen = new Set<string>();
  let cursor: string | null = newParent;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === branch) {
      throw new Error(`cycle: "${newParent}" descends from "${branch}"`);
    }
    seen.add(cursor);
    cursor = project.layers.get(cursor)?.parsed.header.parent ?? null;
  }
  const header = { ...target.parsed.header, parent: newParent };
  return [
    {
      kind: "replace-line",
      file: target.file,
      line: header.loc.line,
      newText: printStmt(header),
    },
  ];
}

/**
 * Resolve a masked correction on `name` (the base changed a value this
 * branch's override shadows). "keep": hold the override, acknowledge the new
 * base by rewriting `(was ...)`. "adopt": blank the override so the base
 * value shows through. The set must be authored in the current branch — a
 * masked correction on an ancestor's set is that layer's to resolve.
 */
export function proposeResolveMasked(
  project: Project,
  branch: string,
  name: string,
  action: "keep" | "adopt",
): TextEdit[] {
  const layers = layerMap(project);
  const eff = resolve(layers, branch).effective.get(name);
  if (eff?.stmt.kind !== "set") throw new Error(`no set override on "${name}"`);
  if (eff.layer !== branch) {
    throw new Error(`override lives on "${eff.layer}" — resolve it on that sheet`);
  }
  const file = project.layers.get(branch)!.file;
  if (action === "adopt") {
    return [{ kind: "replace-line", file, line: eff.stmt.loc.line, newText: "" }];
  }
  // "keep": the base is what the parent chain resolves without this override.
  const parent = project.layers.get(branch)!.parsed.header.parent!;
  const baseEff = resolve(layers, parent).effective.get(name);
  if (baseEff?.stmt.kind !== "param" && baseEff?.stmt.kind !== "set") {
    throw new Error(`no base param "${name}" in ancestor layers`);
  }
  const updated: SetStmt = { ...eff.stmt, was: baseEff.stmt.value };
  return [
    { kind: "replace-line", file, line: eff.stmt.loc.line, newText: printStmt(updated) },
  ];
}

/**
 * Drop the statement behind a review-queue orphan (`unknown-ref`,
 * `set-missing-base`). Statements that resolved delegate to proposeDelete
 * (tombstones + companion keys); statements that failed resolution entirely
 * (a set whose base param is gone) are blanked from the branch file.
 */
export function proposeDropOrphan(
  project: Project,
  branch: string,
  key: string,
): TextEdit[] {
  const resolved = resolve(layerMap(project), branch);
  if ([key, `${key}.length`, `${key}.axis`].some((k) => resolved.effective.has(k))) {
    return proposeDelete(project, branch, key);
  }
  const layer = project.layers.get(branch);
  if (layer === undefined) throw new Error(`no layer "${branch}"`);
  for (const s of layer.parsed.stmts) {
    if (stmtKey(s) === key) {
      return [{ kind: "replace-line", file: layer.file, line: s.loc.line, newText: "" }];
    }
  }
  throw new Error(`nothing to drop at "${key}"`);
}

/** Change a param value/provenance as a text edit (measure or re-approximate). */
export function proposeSetParam(
  project: Project,
  branch: string,
  param: string,
  value: S64,
  prov: ParamStmt["prov"],
  date?: string,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const eff = pipeline.resolved.effective.get(param);
  if (eff === undefined || (eff.stmt.kind !== "param" && eff.stmt.kind !== "set")) {
    throw new Error(`no param "${param}"`);
  }
  const stmt = eff.stmt;
  if (eff.layer === branch) {
    const updated = { ...stmt, value, prov, date };
    return [
      {
        kind: "replace-line",
        file: project.layers.get(eff.layer)!.file,
        line: stmt.loc.line,
        newText: printStmt(updated),
      },
    ];
  }
  const setStmt: SetStmt = {
    kind: "set",
    name: param,
    value,
    prov,
    date,
    was: stmt.value,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  return [
    { kind: "append", file: project.layers.get(branch)!.file, lines: [printStmt(setStmt)] },
  ];
}
