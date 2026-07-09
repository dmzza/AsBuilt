import {
  stmtKey,
  type AxisStmt,
  type JunctionStmt,
  type ParamStmt,
  type ParsedLayer,
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

  if (free.length > 0) {
    // Best single param by explained fraction of the drag vector.
    let best: { s: Sens; dp: number; explained: number } | null = null;
    for (const s of free) {
      const ss = s.sx * s.sx + s.sy * s.sy;
      const dp = (s.sx * delta.x + s.sy * delta.y) / ss;
      const rx = delta.x - dp * s.sx;
      const ry = delta.y - dp * s.sy;
      const explained = 1 - Math.hypot(rx, ry) / deltaMag;
      if (best === null || explained > best.explained) best = { s, dp, explained };
    }
    if (best !== null && best.explained > 0.3 && Math.abs(best.dp) > 1 / 128) {
      const eff = pipeline.resolved.effective.get(best.s.param)!;
      const stmt = eff.stmt as ParamStmt | SetStmt;
      const newValue = stmt.value + s64FromInches(best.dp);
      const owner = project.layers.get(eff.layer);
      if (owner === undefined) {
        return {
          kind: "refusal",
          blockers: [best.s.param],
          message: `param ${best.s.param} owned by unknown layer`,
        };
      }
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
          name: best.s.param,
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
      const verified = verifyMove(project, edits, branch, junction, targetIn);
      return { kind: "param-edit", param: best.s.param, newValue, edits, verified };
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
      eff.layer === branch
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
    const verified = verifyMove(project, edits, branch, junction, targetIn);
    return { kind: "sketch-edit", junction, edits, verified };
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
