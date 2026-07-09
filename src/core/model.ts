import type { ParsedLayer, Provenance } from "./ast";
import { resolve, type Diagnostic, type Resolved } from "./merge";
import {
  buildSystem,
  junctionPos,
  paramValue,
  solve,
  type BuildOptions,
  type Solution,
} from "./solve";
import { s64ToInches } from "./units";

export type Grade = Provenance | "drawn";

const GRADE_RANK: Record<Grade, number> = {
  measured: 3,
  designed: 2,
  approximated: 1,
  drawn: 0,
};

export function weakest(grades: Grade[]): Grade {
  let g: Grade = "measured";
  for (const grade of grades) {
    if (GRADE_RANK[grade] < GRADE_RANK[g]) g = grade;
  }
  return grades.length === 0 ? "drawn" : g;
}

export interface WallView {
  name: string;
  from: string;
  to: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  lengthInches: number;
  wallType: string;
}

export interface ParamView {
  name: string;
  authoredInches: number;
  solvedInches: number;
  prov: Provenance;
  layer: string;
}

export interface Pipeline {
  resolved: Resolved;
  solution: Solution;
  anchors: Set<string>;
  diagnostics: Diagnostic[];
}

/** Anchor convention: the sw corner of every expanded rect room. */
export function defaultAnchors(resolved: Resolved): Set<string> {
  const anchors = new Set<string>();
  for (const [key, eff] of resolved.effective) {
    if (eff.stmt.kind !== "junction") continue;
    if (eff.expandedFrom !== undefined && key.endsWith(".sw")) anchors.add(key);
  }
  return anchors;
}

export function resolveAndSolve(
  layers: Map<string, ParsedLayer>,
  branch: string,
  opts: Omit<BuildOptions, "anchors"> = {},
): Pipeline {
  const resolved = resolve(layers, branch);
  const anchors = defaultAnchors(resolved);
  const system = buildSystem(resolved, { ...opts, anchors });
  const solution = solve(system);
  return { resolved, solution, anchors, diagnostics: resolved.diagnostics };
}

/** Re-solve with one param's target shifted (inches), warm-started. */
export function perturbParam(
  pipeline: Pipeline,
  param: string,
  deltaInches: number,
  extra: Omit<BuildOptions, "anchors" | "paramTargetOverride"> = {},
): Solution {
  const eff = pipeline.resolved.effective.get(param);
  if (eff === undefined || (eff.stmt.kind !== "param" && eff.stmt.kind !== "set")) {
    throw new Error(`perturbParam: no param "${param}"`);
  }
  const base = s64ToInches(eff.stmt.value);
  const system = buildSystem(pipeline.resolved, {
    ...extra,
    anchors: pipeline.anchors,
    paramTargetOverride: new Map([[param, base + deltaInches]]),
  });
  return solve(system, pipeline.solution.x);
}

export function wallView(pipeline: Pipeline, name: string): WallView | null {
  const eff = pipeline.resolved.effective.get(name);
  if (eff?.stmt.kind !== "wall") return null;
  const a = junctionPos(pipeline.solution, eff.stmt.from);
  const b = junctionPos(pipeline.solution, eff.stmt.to);
  if (a === null || b === null) return null;
  return {
    name,
    from: eff.stmt.from,
    to: eff.stmt.to,
    a,
    b,
    lengthInches: Math.hypot(b.x - a.x, b.y - a.y),
    wallType: eff.stmt.wallType,
  };
}

export function paramView(pipeline: Pipeline, name: string): ParamView | null {
  const eff = pipeline.resolved.effective.get(name);
  if (eff === undefined || (eff.stmt.kind !== "param" && eff.stmt.kind !== "set")) {
    return null;
  }
  const solved = paramValue(pipeline.solution, name);
  if (solved === null) return null;
  return {
    name,
    authoredInches: s64ToInches(eff.stmt.value),
    solvedInches: solved,
    prov: eff.stmt.prov,
    layer: eff.layer,
  };
}

/** All params, for the assumption audit. */
export function allParams(pipeline: Pipeline): ParamView[] {
  const out: ParamView[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    const v = paramView(pipeline, key);
    if (v !== null) out.push(v);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const SENSITIVITY_TOL = 0.05; // inches of response to a 1" target shift

/**
 * Provenance support of a derived scalar: which params influence it, and the
 * weakest provenance among them. Empty support = "drawn" (sketch-held).
 */
export function derivedGrade(
  pipeline: Pipeline,
  valueOf: (sol: Solution) => number,
): { grade: Grade; support: string[] } {
  const base = valueOf(pipeline.solution);
  const support: string[] = [];
  const grades: Grade[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    const perturbed = perturbParam(pipeline, key, 1);
    if (Math.abs(valueOf(perturbed) - base) > SENSITIVITY_TOL) {
      support.push(key);
      grades.push(eff.stmt.prov);
    }
  }
  return { grade: weakest(grades), support: support.sort() };
}

/** Grade of a wall's length. */
export function wallLengthGrade(
  pipeline: Pipeline,
  wall: string,
): { grade: Grade; support: string[] } {
  const eff = pipeline.resolved.effective.get(wall);
  if (eff?.stmt.kind !== "wall") throw new Error(`no wall "${wall}"`);
  const { from, to } = eff.stmt;
  return derivedGrade(pipeline, (sol) => {
    const a = junctionPos(sol, from)!;
    const b = junctionPos(sol, to)!;
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
}
