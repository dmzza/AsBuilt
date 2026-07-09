import {
  stmtKey,
  type AxisStmt,
  type FixtureStmt,
  type JunctionStmt,
  type MeasStmt,
  type OpeningStmt,
  type ParamStmt,
  type ParsedLayer,
  type Point,
  type SetStmt,
  type WallStmt,
} from "./ast";
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
    }
  }
  return {
    kind: "refusal",
    blockers: [...blockers].sort(),
    message:
      blockers.size > 0
        ? `locked by measured: ${[...blockers].sort().join(", ")}`
        : `no free parameter or sketch explains this drag`,
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
  },
): AddWallProposal {
  const file = project.layers.get(branch);
  if (file === undefined) throw new Error(`no layer "${branch}"`);
  const lines: string[] = [];
  const created: string[] = [];
  const junctionNames: string[] = [];
  let counter = 0;

  for (const end of [args.a, args.b]) {
    if ("existing" in end) {
      junctionNames.push(end.existing);
    } else {
      // genName scans authored statements only; bump past what we just made
      let name = genName(project, "j");
      while (created.includes(name)) {
        counter += 1;
        name = `j${parseInt(name.slice(1), 10) + counter}`;
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

  let wallName = genName(project, "w");
  while (created.includes(wallName)) wallName = `w${parseInt(wallName.slice(1), 10) + 1}`;
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
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const targets = [key, `${key}.length`, `${key}.axis`].filter((k) =>
    pipeline.resolved.effective.has(k),
  );
  if (targets.length === 0) throw new Error(`nothing to delete at "${key}"`);

  // If deleting a junction, also delete all walls that reference it
  const eff = pipeline.resolved.effective.get(key);
  if (eff?.stmt.kind === "junction") {
    for (const [wallKey, wallEff] of pipeline.resolved.effective) {
      if (wallEff.stmt.kind === "wall") {
        if (wallEff.stmt.from === key || wallEff.stmt.to === key) {
          // Add the wall and its companions to targets
          for (const k of [wallKey, `${wallKey}.length`, `${wallKey}.axis`]) {
            if (pipeline.resolved.effective.has(k) && !targets.includes(k)) {
              targets.push(k);
            }
          }
        }
      }
    }
  }

  const edits: TextEdit[] = [];
  const tombstones: string[] = [];
  for (const t of targets) {
    const eff = pipeline.resolved.effective.get(t)!;
    if (eff.expandedFrom === undefined && eff.layer === branch) {
      edits.push({
        kind: "replace-line",
        file: project.layers.get(branch)!.file,
        line: eff.stmt.loc.line,
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
 * Record a tape measurement. Measuring a wall whose length is bound to a
 * single param makes THAT param measured (define-once: no duplicate truth).
 * Anything else — unbound walls, diagonals, cross-room spans — appends a
 * `meas` distance constraint between the two junctions.
 */
export function proposeMeasure(
  project: Project,
  branch: string,
  target: MeasureTarget,
  value: S64,
  date?: string,
): TextEdit[] {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  let pair: { a: string; b: string };
  if ("wall" in target) {
    const wallEff = pipeline.resolved.effective.get(target.wall);
    if (wallEff?.stmt.kind !== "wall") throw new Error(`no wall "${target.wall}"`);
    const binding = pipeline.resolved.effective.get(`${target.wall}.length`);
    if (binding?.stmt.kind === "length") {
      const terms = binding.stmt.expr.terms;
      const first = terms[0];
      if (terms.length === 1 && first !== undefined && first.kind === "ref" && first.sign === 1) {
        return proposeSetParam(project, branch, first.name, value, "measured", date);
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
  args: { at: Point; fixKind?: string; w?: S64; d?: S64 },
): { edits: TextEdit[]; name: string } {
  const name = genName(project, "f");
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

/** In-place rewrite when the branch owns the authored line, shadow otherwise. */
function replaceOrShadow(
  project: Project,
  branch: string,
  ownerLayer: string,
  expandedFrom: string | undefined,
  line: number,
  updated: OpeningStmt | FixtureStmt,
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
