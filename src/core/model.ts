import type { ParsedLayer, Provenance } from "./ast";
import { evalExpr, resolve, type Diagnostic, type Resolved } from "./merge";
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

/**
 * Anchor convention: one junction per connected component of the wall graph
 * fixes the translation gauge — without it, every parameter's sensitivity
 * smears across every junction of the component. Expanded rect rooms anchor
 * their sw corner; authored components anchor their lexicographically first
 * junction (deterministic across solves).
 */
export function defaultAnchors(resolved: Resolved): Set<string> {
  const anchors = new Set<string>();
  for (const [key, eff] of resolved.effective) {
    if (eff.stmt.kind !== "junction") continue;
    if (eff.expandedFrom !== undefined && key.endsWith(".sw")) anchors.add(key);
  }

  // union-find over junctions connected by walls
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = a;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [, eff] of resolved.effective) {
    if (eff.stmt.kind === "wall") union(eff.stmt.from, eff.stmt.to);
  }

  const componentBest = new Map<string, string>(); // root -> smallest junction
  const componentAnchored = new Set<string>();
  for (const j of parent.keys()) {
    const root = find(j);
    if (anchors.has(j)) componentAnchored.add(root);
    const best = componentBest.get(root);
    if (best === undefined || j < best) componentBest.set(root, j);
  }
  for (const [root, best] of componentBest) {
    if (!componentAnchored.has(root)) anchors.add(best);
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

/**
 * Re-solve with one target statement's value shifted (inches), warm-started.
 * Works for params, set overrides, and meas statements.
 */
export function perturbTarget(
  pipeline: Pipeline,
  key: string,
  deltaInches: number,
  extra: Omit<BuildOptions, "anchors" | "targetOverride"> = {},
): Solution {
  const eff = pipeline.resolved.effective.get(key);
  const s = eff?.stmt;
  if (s === undefined || (s.kind !== "param" && s.kind !== "set" && s.kind !== "meas")) {
    throw new Error(`perturbTarget: no param or meas "${key}"`);
  }
  const base = s64ToInches(s.value);
  const system = buildSystem(pipeline.resolved, {
    ...extra,
    anchors: pipeline.anchors,
    targetOverride: new Map([[key, base + deltaInches]]),
  });
  return solve(system, pipeline.solution.x);
}

/** Back-compat alias for param-only callers. */
export const perturbParam = perturbTarget;

/** Target statements that carry provenance: params/sets and meas (measured). */
function supportTargets(pipeline: Pipeline): { key: string; grade: Grade }[] {
  const out: { key: string; grade: Grade }[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "param" || eff.stmt.kind === "set") {
      out.push({ key, grade: eff.stmt.prov });
    } else if (eff.stmt.kind === "meas") {
      out.push({ key, grade: "measured" });
    }
  }
  return out;
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

export interface OpeningView {
  key: string;
  opKind: "door" | "window";
  wall: string;
  /** Near jamb (closest to anchor) and far jamb, world inches, on the centerline. */
  jambA: { x: number; y: number };
  jambB: { x: number; y: number };
  /** Unit vector along the host wall from its `from` to its `to`. */
  dir: { x: number; y: number };
  widthInches: number;
  heightInches: number;
  sillInches: number;
  offsetInches: number;
  anchor: string;
  /** True when the opening doesn't fit inside its host wall. */
  overflow: boolean;
}

/** Solved world geometry of every opening; overflow flags for diagnostics. */
export function openingViews(pipeline: Pipeline): OpeningView[] {
  const params = new Map<string, number>();
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "param" || eff.stmt.kind === "set") {
      params.set(key, eff.stmt.value);
    }
  }
  const out: OpeningView[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    const s = eff.stmt;
    if (s.kind !== "opening") continue;
    const wallEff = pipeline.resolved.effective.get(s.wall);
    if (wallEff?.stmt.kind !== "wall") continue;
    const a = junctionPos(pipeline.solution, wallEff.stmt.from);
    const b = junctionPos(pipeline.solution, wallEff.stmt.to);
    if (a === null || b === null) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.01) continue;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const offS64 = evalExpr(s.offset, params);
    const off = (offS64 ?? 0) / 64;
    const w = s.width / 64;
    // Anchored at `from`: jambs at off and off+w along dir.
    // Anchored at `to`: measured backwards from the far end.
    const fromAnchored = s.anchor === wallEff.stmt.from;
    const start = fromAnchored ? off : len - off - w;
    out.push({
      key,
      opKind: s.opKind,
      wall: s.wall,
      jambA: { x: a.x + dir.x * start, y: a.y + dir.y * start },
      jambB: { x: a.x + dir.x * (start + w), y: a.y + dir.y * (start + w) },
      dir,
      widthInches: w,
      heightInches: s.height / 64,
      sillInches: (s.sill ?? (s.opKind === "window" ? 30 * 64 : 0)) / 64,
      offsetInches: off,
      anchor: s.anchor,
      overflow: start < -0.01 || start + w > len + 0.01,
    });
  }
  return out;
}

export interface FixtureView {
  key: string;
  fixKind: string;
  x: number;
  y: number;
  w: number;
  d: number;
  rot: 0 | 90 | 180 | 270;
}

export function fixtureViews(pipeline: Pipeline): FixtureView[] {
  const out: FixtureView[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    const s = eff.stmt;
    if (s.kind !== "fixture") continue;
    out.push({
      key,
      fixKind: s.fixKind,
      x: s.at.x / 64,
      y: s.at.y / 64,
      w: s.w / 64,
      d: s.d / 64,
      rot: s.rot,
    });
  }
  return out;
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
  for (const t of supportTargets(pipeline)) {
    const perturbed = perturbTarget(pipeline, t.key, 1);
    if (Math.abs(valueOf(perturbed) - base) > SENSITIVITY_TOL) {
      support.push(t.key);
      grades.push(t.grade);
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

/**
 * Grades for every wall at once: one perturbed solve per param, reused across
 * all walls (the per-wall variant costs walls x params solves).
 */
export function allWallGrades(
  pipeline: Pipeline,
): Map<string, { grade: Grade; support: string[] }> {
  const walls: { key: string; from: string; to: string }[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "wall") {
      walls.push({ key, from: eff.stmt.from, to: eff.stmt.to });
    }
  }
  const lengthIn = (sol: Solution, w: { from: string; to: string }): number => {
    const a = junctionPos(sol, w.from);
    const b = junctionPos(sol, w.to);
    if (a === null || b === null) return NaN;
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  const base = new Map(walls.map((w) => [w.key, lengthIn(pipeline.solution, w)]));
  const support = new Map<string, string[]>(walls.map((w) => [w.key, []]));
  const grades = new Map<string, Grade[]>(walls.map((w) => [w.key, []]));

  for (const t of supportTargets(pipeline)) {
    const perturbed = perturbTarget(pipeline, t.key, 1);
    for (const w of walls) {
      const delta = Math.abs(lengthIn(perturbed, w) - base.get(w.key)!);
      if (delta > SENSITIVITY_TOL) {
        support.get(w.key)!.push(t.key);
        grades.get(w.key)!.push(t.grade);
      }
    }
  }

  const out = new Map<string, { grade: Grade; support: string[] }>();
  for (const w of walls) {
    out.set(w.key, {
      grade: weakest(grades.get(w.key)!),
      support: support.get(w.key)!.sort(),
    });
  }
  return out;
}
