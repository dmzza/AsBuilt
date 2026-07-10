import type { DimRef, FaceRef, Provenance } from "./ast";
import { crossingWallType, faceSign, wallBetween } from "./faces";
import { evalExpr, type EffStmt, type Resolved } from "./merge";
import { s64ToInches } from "./units";

/**
 * Weighted nonlinear least squares over junction coordinates, param values,
 * and walltype thicknesses. All work in float inches. Hard constraints are
 * big-weight soft constraints; a violated hard constraint after convergence
 * is a contradiction.
 *
 * Face-referenced measurements desugar against centerline space:
 *   M = C + eA·½tA + eB·½tB   (e = −1 inner / 0 centerline / +1 outer)
 */

export const W_HARD = 1e3; // structural: axis alignment, length bindings, meas
export const W_MEASURED_PARAM = 1e3;
export const W_SOFT_PARAM = 1; // approximated / designed param targets
/**
 * Soft walltype thickness. Must be ≫ W_SOFT_PARAM so a hard face tape moves
 * free params rather than "splitting the difference" with catalog thickness
 * (which collapsed 4½" stud walls to ~2¼" under equal soft weights).
 * Still soft (hard:false) so dual face reads (inner+outer) can derive true t.
 */
export const W_SOFT_THICKNESS = 100;
export const W_SKETCH = 1e-2; // drawn positions (gauge regularizer)
export const W_ANCHOR = 10; // translation gauge anchor (see anchors set)

/** Hard-constraint violation tolerance: 1/32 inch. */
export const CONTRADICTION_TOL = 1 / 32;

export interface Residual {
  /** Statement key this residual enforces. */
  key: string;
  hard: boolean;
  weight: number;
  /** Variable indices this residual reads (for grouping/diagnostics). */
  vars: number[];
  fn: (x: Float64Array) => number;
}

export interface System {
  /** Variable names: `j:<name>:x|y`, `p:<name>`, or `t:<walltype>`. */
  varNames: string[];
  varIndex: Map<string, number>;
  x0: Float64Array;
  residuals: Residual[];
  paramProv: Map<string, Provenance>;
  /** Thickness provenance keyed by walltype name. */
  thicknessProv: Map<string, Provenance>;
}

export interface Contradiction {
  /** Violated hard-constraint statement keys. */
  violated: { key: string; residualInches: number }[];
  /** Measured statements adjacent to the violation (the suspects). */
  suspects: string[];
}

export interface Solution {
  x: Float64Array;
  system: System;
  iterations: number;
  converged: boolean;
  contradictions: Contradiction[];
}

export interface BuildOptions {
  /** Junction names to anchor with W_ANCHOR (translation gauge). */
  anchors?: Set<string>;
  /** Override a junction's sketch target, e.g. during drag probing. */
  sketchOverride?: Map<string, { x: number; y: number }>;
  /**
   * Override a target value in inches, keyed by statement key. Applies to
   * param targets and meas values — used for sensitivity probing.
   */
  targetOverride?: Map<string, number>;
}

export function buildSystem(resolved: Resolved, opts: BuildOptions = {}): System {
  const varNames: string[] = [];
  const varIndex = new Map<string, number>();
  const x0: number[] = [];
  const residuals: Residual[] = [];
  const paramProv = new Map<string, Provenance>();
  const thicknessProv = new Map<string, Provenance>();

  const addVar = (name: string, init: number): number => {
    const i = varNames.length;
    varNames.push(name);
    varIndex.set(name, i);
    x0.push(init);
    return i;
  };

  // Variables + target residuals
  for (const [key, eff] of resolved.effective) {
    const s = eff.stmt;
    if (s.kind === "junction") {
      const sk = opts.sketchOverride?.get(key);
      const tx = sk?.x ?? s64ToInches(s.sketch.x);
      const ty = sk?.y ?? s64ToInches(s.sketch.y);
      const xi = addVar(`j:${key}:x`, tx);
      const yi = addVar(`j:${key}:y`, ty);
      const w = opts.anchors?.has(key) ? W_ANCHOR : W_SKETCH;
      residuals.push({
        key,
        hard: false,
        weight: w,
        vars: [xi],
        fn: (x) => x[xi]! - tx,
      });
      residuals.push({
        key,
        hard: false,
        weight: w,
        vars: [yi],
        fn: (x) => x[yi]! - ty,
      });
    } else if (s.kind === "param" || s.kind === "set") {
      const target = opts.targetOverride?.get(key) ?? s64ToInches(s.value);
      const pi = addVar(`p:${key}`, target);
      paramProv.set(key, s.prov);
      const w = s.prov === "measured" ? W_MEASURED_PARAM : W_SOFT_PARAM;
      residuals.push({
        key,
        hard: s.prov === "measured",
        weight: w,
        vars: [pi],
        fn: (x) => x[pi]! - target,
      });
    } else if (s.kind === "walltype") {
      // Thickness is a solver target: hard when measured, stiff-soft otherwise.
      // Override key is the walltype name (same as statement key).
      const target = opts.targetOverride?.get(key) ?? s64ToInches(s.thickness);
      const ti = addVar(`t:${key}`, target);
      thicknessProv.set(key, s.prov);
      const hard = s.prov === "measured";
      const w = hard ? W_MEASURED_PARAM : W_SOFT_THICKNESS;
      residuals.push({
        key,
        hard,
        weight: w,
        vars: [ti],
        fn: (x) => x[ti]! - target,
      });
    }
  }

  const jVar = (name: string, axis: "x" | "y"): number | null =>
    varIndex.get(`j:${name}:${axis}`) ?? null;

  const tVar = (wallType: string): number | null =>
    varIndex.get(`t:${wallType}`) ?? null;

  /** Room dims for a wall expanded from a rect template. */
  const roomDimsOf = (wallName: string): DimRef => {
    const wallEff = resolved.effective.get(wallName);
    const roomName = wallEff?.expandedFrom;
    if (roomName === undefined) return "centerline";
    const room = resolved.effective.get(roomName);
    if (room?.stmt.kind !== "room") return "centerline";
    return room.stmt.dims ?? "centerline";
  };

  /**
   * Crossing-thickness var indices at each end of a wall, for face residual
   * terms. Returns null type → no contribution at that end.
   */
  const endThickness = (
    junction: string,
    spanWall: string | null,
    end: "inner" | "outer" | "centerline",
  ): { type: string | null; ti: number | null; sign: -1 | 0 | 1 } => {
    const sign = faceSign(end);
    if (sign === 0) return { type: null, ti: null, sign: 0 };
    const type = crossingWallType(resolved, junction, spanWall);
    return { type, ti: type !== null ? tVar(type) : null, sign };
  };

  // Constraint residuals
  for (const [key, eff] of resolved.effective) {
    const s = eff.stmt;
    if (s.kind === "axis") {
      const wallEff = resolved.effective.get(s.wall);
      if (wallEff?.stmt.kind !== "wall") continue;
      const { from, to } = wallEff.stmt;
      const axis = s.orient === "h" ? "y" : "x";
      const ai = jVar(from, axis);
      const bi = jVar(to, axis);
      if (ai === null || bi === null) continue;
      residuals.push({
        key,
        hard: true,
        weight: W_HARD,
        vars: [ai, bi],
        fn: (x) => x[ai]! - x[bi]!,
      });
    } else if (s.kind === "length") {
      const wallEff = resolved.effective.get(s.wall);
      if (wallEff?.stmt.kind !== "wall") continue;
      const { from, to } = wallEff.stmt;
      const axi = jVar(from, "x");
      const ayi = jVar(from, "y");
      const bxi = jVar(to, "x");
      const byi = jVar(to, "y");
      if (axi === null || ayi === null || bxi === null || byi === null) continue;
      const termVars: number[] = [axi, ayi, bxi, byi];
      const refIdx: { sign: number; i: number }[] = [];
      let litSum = 0;
      for (const t of s.expr.terms) {
        if (t.kind === "lit") {
          litSum += t.sign * s64ToInches(t.value);
        } else {
          const i = varIndex.get(`p:${t.name}`);
          if (i === undefined) continue;
          refIdx.push({ sign: t.sign, i });
          termVars.push(i);
        }
      }

      // dims:inner on the parent room: param is clear interior, so
      // C = expr + ½tA + ½tB  (residual C − expr − ½tA − ½tB).
      // dims:outer: C = expr − ½tA − ½tB.
      const dims = roomDimsOf(s.wall);
      const faceEnd: FaceRef | undefined =
        dims === "inner"
          ? { a: "inner", b: "inner" }
          : dims === "outer"
            ? { a: "outer", b: "outer" }
            : undefined;
      // For dims, the residual uses opposite signs of the meas convention:
      // meas: C + e·½t − M = 0 with e_inner = −1 → C − ½t − M = 0.
      // length with dims:inner: C − (param + ½t) = 0 → C − param − ½t = 0.
      // So dims:inner adds −½t (same as meas e=−1 with target = expr).
      const endA = endThickness(from, s.wall, faceEnd?.a ?? "centerline");
      const endB = endThickness(to, s.wall, faceEnd?.b ?? "centerline");
      // dims sign: for inner, we want −½t on each end (param is smaller than C);
      // endThickness with "inner" gives e=−1, and we use e·½t in residual below
      // with form C + e·½t − expr. For e=−1: C − ½t − expr. Correct.
      // For outer e=+1: C + ½t − expr → C = expr − ½t. Correct (outer param > C).
      if (endA.ti !== null) termVars.push(endA.ti);
      if (endB.ti !== null) termVars.push(endB.ti);

      residuals.push({
        key,
        hard: true,
        weight: W_HARD,
        vars: uniqVars(termVars),
        fn: (x) => {
          const dx = x[bxi]! - x[axi]!;
          const dy = x[byi]! - x[ayi]!;
          let expr = litSum;
          for (const r of refIdx) expr += r.sign * x[r.i]!;
          let face = 0;
          if (endA.ti !== null) face += endA.sign * 0.5 * x[endA.ti]!;
          if (endB.ti !== null) face += endB.sign * 0.5 * x[endB.ti]!;
          return Math.hypot(dx, dy) + face - expr;
        },
      });
    } else if (s.kind === "stack") {
      // bearing alignment: `a` sits directly over `b` in plan
      const axi = jVar(s.a, "x");
      const ayi = jVar(s.a, "y");
      const bxi = jVar(s.b, "x");
      const byi = jVar(s.b, "y");
      if (axi === null || ayi === null || bxi === null || byi === null) continue;
      residuals.push({
        key,
        hard: true,
        weight: W_HARD,
        vars: [axi, bxi],
        fn: (x) => x[axi]! - x[bxi]!,
      });
      residuals.push({
        key,
        hard: true,
        weight: W_HARD,
        vars: [ayi, byi],
        fn: (x) => x[ayi]! - x[byi]!,
      });
    } else if (s.kind === "meas") {
      const axi = jVar(s.a, "x");
      const ayi = jVar(s.a, "y");
      const bxi = jVar(s.b, "x");
      const byi = jVar(s.b, "y");
      if (axi === null || ayi === null || bxi === null || byi === null) continue;
      const target = opts.targetOverride?.get(key) ?? s64ToInches(s.value);
      const span = wallBetween(resolved, s.a, s.b);
      const spanName = span?.name ?? null;
      const ref = s.ref;
      const endA = endThickness(s.a, spanName, ref?.a ?? "centerline");
      const endB = endThickness(s.b, spanName, ref?.b ?? "centerline");
      const termVars: number[] = [axi, ayi, bxi, byi];
      if (endA.ti !== null) termVars.push(endA.ti);
      if (endB.ti !== null) termVars.push(endB.ti);
      // residual: C + eA·½tA + eB·½tB − M = 0
      residuals.push({
        key,
        hard: true,
        weight: W_HARD,
        vars: uniqVars(termVars),
        fn: (x) => {
          const dx = x[bxi]! - x[axi]!;
          const dy = x[byi]! - x[ayi]!;
          let face = 0;
          if (endA.ti !== null) face += endA.sign * 0.5 * x[endA.ti]!;
          if (endB.ti !== null) face += endB.sign * 0.5 * x[endB.ti]!;
          return Math.hypot(dx, dy) + face - target;
        },
      });
    }
  }

  return {
    varNames,
    varIndex,
    x0: Float64Array.from(x0),
    residuals,
    paramProv,
    thicknessProv,
  };
}

/** Unique var indices — duplicates break numeric Jacobian assembly (double-count). */
function uniqVars(vars: number[]): number[] {
  if (vars.length <= 1) return vars;
  return [...new Set(vars)];
}

/** Dense Gaussian elimination with partial pivoting. A is n x n row-major. */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A);
  const y = Float64Array.from(b);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col * n + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * n + col]!);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-14) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = M[col * n + c]!;
        M[col * n + c] = M[pivot * n + c]!;
        M[pivot * n + c] = t;
      }
      const t = y[col]!;
      y[col] = y[pivot]!;
      y[pivot] = t;
    }
    const d = M[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col]! / d;
      if (f === 0) continue;
      M[r * n + col] = 0;
      for (let c = col + 1; c < n; c++) M[r * n + c] = M[r * n + c]! - f * M[col * n + c]!;
      y[r] = y[r]! - f * y[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = y[r]!;
    for (let c = r + 1; c < n; c++) acc -= M[r * n + c]! * x[c]!;
    x[r] = acc / M[r * n + r]!;
  }
  return x;
}

function cost(system: System, x: Float64Array): number {
  let total = 0;
  for (const r of system.residuals) {
    const v = r.weight * r.fn(x);
    total += v * v;
  }
  return total;
}

/** Levenberg-Marquardt with numeric Jacobian. */
export function solve(system: System, x0?: Float64Array): Solution {
  const n = system.varNames.length;
  const m = system.residuals.length;
  let x = Float64Array.from(x0 ?? system.x0);
  let lambda = 1e-3;
  let converged = false;
  let iter = 0;

  const FD_H = 1e-5;

  for (iter = 0; iter < 100; iter++) {
    // residual vector (weighted) and numeric Jacobian
    const r = new Float64Array(m);
    for (let i = 0; i < m; i++) r[i] = system.residuals[i]!.weight * system.residuals[i]!.fn(x);

    // sparse-ish: only differentiate wrt vars each residual declares
    const JtJ = new Float64Array(n * n);
    const Jtr = new Float64Array(n);
    const xp = Float64Array.from(x);
    for (let i = 0; i < m; i++) {
      const res = system.residuals[i]!;
      const base = r[i]!;
      const grads: { j: number; g: number }[] = [];
      for (const j of res.vars) {
        const keep = xp[j]!;
        xp[j] = keep + FD_H;
        const plus = res.weight * res.fn(xp);
        xp[j] = keep;
        const g = (plus - base) / FD_H;
        if (g !== 0) grads.push({ j, g });
      }
      for (const a of grads) {
        Jtr[a.j] = Jtr[a.j]! + a.g * base;
        for (const b of grads) {
          JtJ[a.j * n + b.j] = JtJ[a.j * n + b.j]! + a.g * b.g;
        }
      }
    }

    // check gradient convergence
    let gmax = 0;
    for (let j = 0; j < n; j++) gmax = Math.max(gmax, Math.abs(Jtr[j]!));
    if (gmax < 1e-10) {
      converged = true;
      break;
    }

    const before = cost(system, x);
    let stepped = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const A = Float64Array.from(JtJ);
      for (let j = 0; j < n; j++) A[j * n + j] = A[j * n + j]! + lambda * (1 + A[j * n + j]!);
      const negJtr = Float64Array.from(Jtr, (v) => -v);
      const delta = solveLinear(A, negJtr, n);
      if (delta !== null) {
        const trial = Float64Array.from(x);
        let dmax = 0;
        for (let j = 0; j < n; j++) {
          trial[j] = trial[j]! + delta[j]!;
          dmax = Math.max(dmax, Math.abs(delta[j]!));
        }
        const after = cost(system, trial);
        if (after <= before) {
          x = trial;
          lambda = Math.max(lambda * 0.3, 1e-12);
          stepped = true;
          if (dmax < 1e-10) converged = true;
          break;
        }
      }
      lambda *= 10;
    }
    if (!stepped) {
      // LM can't improve even with a huge lambda: we're at (or pinned near)
      // the optimum. Accept when the gradient is small relative to the cost —
      // an inconsistent system (least-squares compromise between hard
      // constraints) floors the absolute gradient at FD noise ~1e-5.
      converged = converged || gmax < 1e-6 * (1 + before);
      break;
    }
    if (converged) break;
  }

  // contradictions: violated hard residuals, grouped by shared variables
  const violated = system.residuals
    .map((res, i) => ({ res, i, v: Math.abs(res.fn(x)) }))
    .filter((e) => e.res.hard && e.v > CONTRADICTION_TOL);

  const contradictions: Contradiction[] = [];
  if (violated.length > 0) {
    // union-find over violated residuals sharing variables
    const parent = violated.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const byVar = new Map<number, number[]>();
    violated.forEach((e, i) => {
      for (const v of e.res.vars) {
        const list = byVar.get(v) ?? [];
        list.push(i);
        byVar.set(v, list);
      }
    });
    for (const list of byVar.values()) {
      for (let i = 1; i < list.length; i++) {
        const a = find(list[0]!);
        const b = find(list[i]!);
        if (a !== b) parent[a] = b;
      }
    }
    const groups = new Map<number, typeof violated>();
    violated.forEach((e, i) => {
      const root = find(i);
      const g = groups.get(root) ?? [];
      g.push(e);
      groups.set(root, g);
    });

    for (const group of groups.values()) {
      const groupVars = new Set<number>();
      for (const e of group) for (const v of e.res.vars) groupVars.add(v);
      // suspects: measured/hard statements sharing a variable with the group
      const suspects = new Set<string>();
      for (const res of system.residuals) {
        if (!res.hard) continue;
        if (res.vars.some((v) => groupVars.has(v))) suspects.add(res.key);
      }
      contradictions.push({
        violated: group.map((e) => ({ key: e.res.key, residualInches: e.v })),
        suspects: [...suspects].sort(),
      });
    }
  }

  return { x, system, iterations: iter, converged, contradictions };
}

/** Solved value of a junction (inches). */
export function junctionPos(
  sol: Solution,
  name: string,
): { x: number; y: number } | null {
  const xi = sol.system.varIndex.get(`j:${name}:x`);
  const yi = sol.system.varIndex.get(`j:${name}:y`);
  if (xi === undefined || yi === undefined) return null;
  return { x: sol.x[xi]!, y: sol.x[yi]! };
}

/** Solved value of a param (inches). */
export function paramValue(sol: Solution, name: string): number | null {
  const i = sol.system.varIndex.get(`p:${name}`);
  return i === undefined ? null : sol.x[i]!;
}

/** Solved thickness of a walltype (inches). */
export function thicknessValue(sol: Solution, wallType: string): number | null {
  const i = sol.system.varIndex.get(`t:${wallType}`);
  return i === undefined ? null : sol.x[i]!;
}

export { evalExpr };
export type { EffStmt };
