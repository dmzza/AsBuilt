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
import { perturbParam, resolveAndSolve, wallView, type Pipeline } from "./model";
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

export type MoveOpts = {
  /**
   * Hold Alt/⌥: allow rewriting measured params (and re-taping meases) so the
   * drag can break hard constraints. Conflicting hard values surface in Review.
   */
  forceBreak?: boolean;
};

export type MoveProposal =
  | {
      kind: "param-edit";
      param: string;
      newValue: S64;
      edits: TextEdit[];
      verified: boolean;
      /** Measured keys rewritten under forceBreak (for toast / review hint). */
      broke?: string[];
    }
  | {
      kind: "sketch-edit";
      junction: string;
      edits: TextEdit[];
      verified: boolean;
      broke?: string[];
    }
  | {
      kind: "room-move";
      room: string;
      edits: TextEdit[];
      verified: boolean;
      broke?: string[];
    }
  | {
      kind: "wall-move";
      wall: string;
      edits: TextEdit[];
      verified: boolean;
      broke?: string[];
    }
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

/** Sensitivity of a wall's midpoint to each param (for wall drags). */
function wallMidSensitivities(
  pipeline: Pipeline,
  from: string,
  to: string,
): Sens[] {
  const a0 = junctionPos(pipeline.solution, from);
  const b0 = junctionPos(pipeline.solution, to);
  if (a0 === null || b0 === null) return [];
  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const out: Sens[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    const sol = perturbParam(pipeline, key, 1);
    const a1 = junctionPos(sol, from);
    const b1 = junctionPos(sol, to);
    if (a1 === null || b1 === null) continue;
    const mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    out.push({
      param: key,
      prov: eff.stmt.prov,
      sx: mid1.x - mid0.x,
      sy: mid1.y - mid0.y,
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

/** True when edits translate both wall endpoints by `delta` (midpoint + ends). */
export function verifyWallMove(
  project: Project,
  edits: TextEdit[],
  branch: string,
  from: string,
  to: string,
  targetMid: { x: number; y: number },
  /** Also require endpoints to move by approximately the same delta. */
  delta: { x: number; y: number },
): boolean {
  try {
    // Get original positions before edits
    const orig = resolveAndSolve(layerMap(project), branch);
    const a0 = junctionPos(orig.solution, from);
    const b0 = junctionPos(orig.solution, to);
    if (a0 === null || b0 === null) return false;

    // Apply edits and get new positions
    const next = applyEdits(project, edits);
    const p = resolveAndSolve(layerMap(next), branch);
    const a = junctionPos(p.solution, from);
    const b = junctionPos(p.solution, to);
    if (a === null || b === null) return false;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (Math.hypot(mid.x - targetMid.x, mid.y - targetMid.y) > VERIFY_TOL) return false;

    // Verify both endpoints moved by approximately the same translation delta.
    const deltaA = { x: a.x - a0.x, y: a.y - a0.y };
    const deltaB = { x: b.x - b0.x, y: b.y - b0.y };
    const errA = Math.hypot(deltaA.x - delta.x, deltaA.y - delta.y);
    const errB = Math.hypot(deltaB.x - delta.x, deltaB.y - delta.y);
    if (errA > VERIFY_TOL || errB > VERIFY_TOL) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite a param for a drag. Measured values may only change when
 * `allowMeasuredRewrite` (force-break); they are always demoted — a drag is
 * never a field re-tape.
 */
function paramEditFor(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  param: string,
  newValue: S64,
  allowMeasuredRewrite: boolean,
): TextEdit[] | null {
  const eff = pipeline.resolved.effective.get(param);
  if (eff === undefined || (eff.stmt.kind !== "param" && eff.stmt.kind !== "set")) {
    return null;
  }
  const stmt = eff.stmt;
  if (stmt.prov === "measured" && !allowMeasuredRewrite) return null;
  const owner = project.layers.get(eff.layer);
  if (owner === undefined) return null;

  const demote = stmt.prov === "measured";
  if (eff.layer === branch) {
    const updated: ParamStmt | SetStmt = demote
      ? { ...stmt, value: newValue, prov: "approximated", date: undefined }
      : { ...stmt, value: newValue };
    return [
      {
        kind: "replace-line",
        file: owner.file,
        line: stmt.loc.line,
        newText: printStmt(updated),
      },
    ];
  }
  const isRoot = project.layers.get(branch)!.parsed.header.parent === null;
  const prov = demote
    ? isRoot
      ? "approximated"
      : "designed"
    : isRoot
      ? stmt.prov
      : "designed";
  const setStmt: SetStmt = {
    kind: "set",
    name: param,
    value: newValue,
    prov,
    was: stmt.value,
    loc: { file: "", line: 0 },
    leadingComments: [],
  };
  return [
    {
      kind: "append",
      file: project.layers.get(branch)!.file,
      lines: [printStmt(setStmt)],
    },
  ];
}

/** Drop meases that pin any of the given junctions (drag ≠ tape). */
function stripMeasesTouching(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  junctions: string[],
): { edits: TextEdit[]; removed: string[] } {
  const jset = new Set(junctions);
  const edits: TextEdit[] = [];
  const removed: string[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "meas") continue;
    if (!jset.has(eff.stmt.a) && !jset.has(eff.stmt.b)) continue;
    removed.push(key);
    if (eff.layer === branch && eff.expandedFrom === undefined) {
      edits.push({
        kind: "replace-line",
        file: project.layers.get(branch)!.file,
        line: eff.stmt.loc.line,
        newText: "",
      });
    } else {
      edits.push({
        kind: "append",
        file: project.layers.get(branch)!.file,
        lines: [`delete ${key}`],
      });
    }
  }
  return { edits, removed };
}

const STALE_MEAS_TOL = 1 / 16; // inches

/**
 * Safety net after any drag: a drag is not a re-tape.
 *
 * If a wall's **solved centerline length** changed and that wall was backed by
 * a measured param or meas, invalidate that measurement (demote param /
 * remove meas). Same if a measured param's authored value was rewritten but
 * still marked measured.
 */
function finalizeDragEdits(
  project: Project,
  branch: string,
  before: Pipeline,
  edits: TextEdit[],
  _junctions: string[],
): { edits: TextEdit[]; demoted: string[] } {
  if (edits.length === 0) return { edits, demoted: [] };

  const nextProj = applyEdits(project, edits);
  const pipe = resolveAndSolve(layerMap(nextProj), branch);
  const demoted: string[] = [];
  const fix: TextEdit[] = [];

  // Wall lengths before the drag
  const lenBefore = new Map<string, number>();
  for (const [key, eff] of before.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    const wv = wallView(before, key);
    if (wv !== null) lenBefore.set(key, wv.lengthInches);
  }

  // Walls whose centerline length changed
  const lengthChanged = new Set<string>();
  for (const [key, eff] of pipe.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    const wv = wallView(pipe, key);
    if (wv === null) continue;
    const prev = lenBefore.get(key);
    if (prev === undefined) continue;
    if (Math.abs(wv.lengthInches - prev) > STALE_MEAS_TOL) lengthChanged.add(key);
  }

  // Param → walls with sole length binding to that param
  const paramWalls = new Map<string, string[]>();
  for (const [, eff] of pipe.resolved.effective) {
    if (eff.stmt.kind !== "length") continue;
    const terms = eff.stmt.expr.terms;
    const first = terms[0];
    if (terms.length !== 1 || first === undefined || first.kind !== "ref" || first.sign !== 1) {
      continue;
    }
    const list = paramWalls.get(first.name) ?? [];
    list.push(eff.stmt.wall);
    paramWalls.set(first.name, list);
  }

  // Demote measured params that (a) had their value rewritten, or (b) own a
  // wall whose centerline length changed under this drag.
  for (const [key, eff] of before.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    if (eff.stmt.prov !== "measured") continue;
    const afterEff = pipe.resolved.effective.get(key);
    if (afterEff === undefined) continue;
    if (afterEff.stmt.kind !== "param" && afterEff.stmt.kind !== "set") continue;
    const afterStmt = afterEff.stmt;

    const valueChanged = afterStmt.value !== eff.stmt.value;
    const ownsChangedWall = (paramWalls.get(key) ?? []).some((w) =>
      lengthChanged.has(w),
    );

    if (afterStmt.prov !== "measured") {
      if (valueChanged || ownsChangedWall) demoted.push(key);
      continue;
    }
    if (!valueChanged && !ownsChangedWall) continue;

    // Pick new value: if a bound wall length changed, use that length.
    let newValue = afterStmt.value;
    for (const wall of paramWalls.get(key) ?? []) {
      if (!lengthChanged.has(wall)) continue;
      const wv = wallView(pipe, wall);
      if (wv !== null) {
        newValue = s64FromInches(wv.lengthInches);
        break;
      }
    }
    if (valueChanged && !ownsChangedWall) newValue = afterStmt.value;

    const demotedStmt =
      afterStmt.kind === "param"
        ? ({
            ...afterStmt,
            value: newValue,
            prov: "approximated" as const,
            date: undefined,
          } satisfies ParamStmt)
        : ({
            ...afterStmt,
            value: newValue,
            prov: "approximated" as const,
            date: undefined,
          } satisfies SetStmt);
    if (afterEff.layer === branch && afterEff.expandedFrom === undefined) {
      fix.push({
        kind: "replace-line",
        file: nextProj.layers.get(branch)!.file,
        line: afterStmt.loc.line,
        newText: printStmt(demotedStmt),
      });
    } else {
      fix.push({
        kind: "append",
        file: nextProj.layers.get(branch)!.file,
        lines: [printStmt(demotedStmt)],
      });
    }
    demoted.push(key);
  }

  // Remove meases that (a) no longer match geometry, or (b) span a wall whose
  // length changed (same endpoints as a changed wall).
  for (const [key, eff] of pipe.resolved.effective) {
    if (eff.stmt.kind !== "meas") continue;
    const a = junctionPos(pipe.solution, eff.stmt.a);
    const b = junctionPos(pipe.solution, eff.stmt.b);
    if (a === null || b === null) continue;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const taped = eff.stmt.value / 64;
    const distMismatch = Math.abs(dist - taped) > STALE_MEAS_TOL;

    // Wall with same two endpoints whose length changed
    let spansChangedWall = false;
    for (const w of lengthChanged) {
      const we = pipe.resolved.effective.get(w);
      if (we?.stmt.kind !== "wall") continue;
      const { from, to } = we.stmt;
      if (
        (from === eff.stmt.a && to === eff.stmt.b) ||
        (from === eff.stmt.b && to === eff.stmt.a)
      ) {
        spansChangedWall = true;
        break;
      }
    }
    // Also: meas endpoints are exactly the ends of a changed wall
    if (!spansChangedWall) {
      for (const w of lengthChanged) {
        const we = before.resolved.effective.get(w);
        if (we?.stmt.kind !== "wall") continue;
        if (
          (we.stmt.from === eff.stmt.a && we.stmt.to === eff.stmt.b) ||
          (we.stmt.from === eff.stmt.b && we.stmt.to === eff.stmt.a)
        ) {
          spansChangedWall = true;
          break;
        }
      }
    }

    // Meas touches a junction that moved (any wall endpoint that moved enough)
    let endpointMoved = false;
    for (const jName of [eff.stmt.a, eff.stmt.b]) {
      const pb = junctionPos(before.solution, jName);
      const pa = junctionPos(pipe.solution, jName);
      if (pb === null || pa === null) continue;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > STALE_MEAS_TOL) {
        endpointMoved = true;
        break;
      }
    }

    if (!distMismatch && !spansChangedWall && !endpointMoved) continue;

    demoted.push(key);
    if (eff.layer === branch && eff.expandedFrom === undefined) {
      fix.push({
        kind: "replace-line",
        file: nextProj.layers.get(branch)!.file,
        line: eff.stmt.loc.line,
        newText: "",
      });
    } else {
      fix.push({
        kind: "append",
        file: nextProj.layers.get(branch)!.file,
        lines: [`delete ${key}`],
      });
    }
  }

  const all = fix.length > 0 ? [...edits, ...fix] : [...edits];
  return { edits: all, demoted: [...new Set(demoted)] };
}

function withFinalizedDrag(
  project: Project,
  branch: string,
  before: Pipeline,
  proposal: MoveProposal,
  junctions: string[],
): MoveProposal {
  if (proposal.kind === "refusal") return proposal;
  if (proposal.edits.length === 0) return proposal;
  const { edits, demoted } = finalizeDragEdits(
    project,
    branch,
    before,
    proposal.edits,
    junctions,
  );
  const broke = [...new Set([...(proposal.broke ?? []), ...demoted])];
  return {
    ...proposal,
    edits,
    broke: broke.length > 0 ? broke : undefined,
  };
}

/** Single-param projection score: how much of `delta` lies along sensitivity `s`. */
function paramExplain(
  s: Sens,
  delta: { x: number; y: number },
  deltaMag: number,
): { dp: number; explained: number } {
  const ss = s.sx * s.sx + s.sy * s.sy;
  if (ss < SENS_TOL * SENS_TOL) return { dp: 0, explained: 0 };
  const dp = (s.sx * delta.x + s.sy * delta.y) / ss;
  const rx = delta.x - dp * s.sx;
  const ry = delta.y - dp * s.sy;
  return { dp, explained: 1 - Math.hypot(rx, ry) / deltaMag };
}

/**
 * Greedy multi-param fit: peel residual onto the best remaining param until the
 * drag is explained (or we run out of useful knobs). Then refine with a true
 * least-squares on the selected set so nearly-orthogonal dims (width+depth)
 * share the delta correctly.
 */
function multiParamDps(
  pool: Sens[],
  delta: { x: number; y: number },
  maxParams = 3,
): { s: Sens; dp: number }[] {
  let rx = delta.x;
  let ry = delta.y;
  const used = new Set<string>();
  const picked: Sens[] = [];

  for (let k = 0; k < maxParams; k++) {
    const rMag = Math.hypot(rx, ry);
    if (rMag < 1 / 64) break;
    let best: { s: Sens; explained: number } | null = null;
    for (const s of pool) {
      if (used.has(s.param)) continue;
      const { explained } = paramExplain(s, { x: rx, y: ry }, rMag);
      if (explained < 0.15) continue;
      if (best === null || explained > best.explained) best = { s, explained };
    }
    if (best === null) break;
    used.add(best.s.param);
    picked.push(best.s);
    // provisional residual peel (refined by LS below)
    const { dp } = paramExplain(best.s, { x: rx, y: ry }, rMag);
    rx -= dp * best.s.sx;
    ry -= dp * best.s.sy;
  }
  if (picked.length === 0) return [];

  // Least squares: min ||Σ dp_i s_i − delta||²  via normal equations (n≤3).
  const n = picked.length;
  const sts = new Float64Array(n * n);
  const std = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const si = picked[i]!;
    std[i] = si.sx * delta.x + si.sy * delta.y;
    for (let j = 0; j < n; j++) {
      const sj = picked[j]!;
      sts[i * n + j] = si.sx * sj.sx + si.sy * sj.sy;
    }
  }
  const dps = solveSmallSymmetric(sts, std, n);
  if (dps === null) {
    // fall back to greedy peels only
    const greedy: { s: Sens; dp: number }[] = [];
    rx = delta.x;
    ry = delta.y;
    for (const s of picked) {
      const rMag = Math.hypot(rx, ry);
      if (rMag < 1 / 64) break;
      const { dp } = paramExplain(s, { x: rx, y: ry }, rMag);
      if (Math.abs(dp) < 1 / 128) continue;
      greedy.push({ s, dp });
      rx -= dp * s.sx;
      ry -= dp * s.sy;
    }
    return greedy;
  }
  return picked
    .map((s, i) => ({ s, dp: dps[i]! }))
    .filter((c) => Math.abs(c.dp) > 1 / 128);
}

/** Dense symmetric solve for n×n with n ≤ 4 (Cholesky-ish via Gauss). */
function solveSmallSymmetric(
  A: Float64Array,
  b: Float64Array,
  n: number,
): Float64Array | null {
  const M = Float64Array.from(A);
  const y = Float64Array.from(b);
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
      const tb = y[col]!;
      y[col] = y[pivot]!;
      y[pivot] = tb;
    }
    const d = M[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col]! / d;
      M[r * n + col] = 0;
      for (let c = col + 1; c < n; c++) {
        M[r * n + c] = M[r * n + c]! - f * M[col * n + c]!;
      }
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

function buildParamEdits(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  changes: { s: Sens; dp: number }[],
  forceBreak: boolean,
): { edits: TextEdit[]; primary: string; primaryValue: S64; broke: string[] } | null {
  const edits: TextEdit[] = [];
  const broke: string[] = [];
  let primary = "";
  let primaryValue = 0;
  for (const { s, dp } of changes) {
    const eff = pipeline.resolved.effective.get(s.param);
    if (eff === undefined || (eff.stmt.kind !== "param" && eff.stmt.kind !== "set")) {
      continue;
    }
    const stmt = eff.stmt;
    const newValue = stmt.value + s64FromInches(dp);
    // Measured only rewritable under force-break; always demoted when rewritten.
    const e = paramEditFor(project, branch, pipeline, s.param, newValue, forceBreak);
    if (e === null) continue;
    edits.push(...e);
    if (primary === "") {
      primary = s.param;
      primaryValue = newValue;
    }
    if (stmt.prov === "measured") broke.push(s.param);
  }
  if (edits.length === 0 || primary === "") return null;
  return { edits, primary, primaryValue, broke };
}

/**
 * Prefer a single param when it fully explains the drag; otherwise fit several
 * params at once (e.g. width+depth for a northeast corner drag).
 */
function tryParamCandidates(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  sens: Sens[],
  delta: { x: number; y: number },
  deltaMag: number,
  forceBreak: boolean,
  verify: (edits: TextEdit[]) => boolean,
): Extract<MoveProposal, { kind: "param-edit" }> | null {
  const pool = forceBreak
    ? sens.filter((s) => Math.hypot(s.sx, s.sy) > SENS_TOL)
    : sens.filter((s) => s.prov !== "measured" && Math.hypot(s.sx, s.sy) > SENS_TOL);
  if (pool.length === 0) return null;

  const singles = pool
    .map((s) => {
      const { dp, explained } = paramExplain(s, delta, deltaMag);
      return { s, dp, explained };
    })
    .filter((c) => c.explained > 0.3 && Math.abs(c.dp) > 1 / 128)
    .sort((a, b) => b.explained - a.explained);

  // 1) Any single param that verifies — prefer best explained first.
  //    (Do this before multi: under hard meases, FD sensitivities couple
  //    params and multi-LS can overfit a pure-axis drag.)
  for (const cand of singles) {
    const built = buildParamEdits(
      project,
      branch,
      pipeline,
      [{ s: cand.s, dp: cand.dp }],
      forceBreak,
    );
    if (built === null) continue;
    if (verify(built.edits)) {
      return {
        kind: "param-edit",
        param: built.primary,
        newValue: built.primaryValue,
        edits: built.edits,
        verified: true,
        broke: built.broke.length > 0 ? built.broke : undefined,
      };
    }
  }

  // 2) Multi-param least squares when no single knob lands the handle.
  const multi = multiParamDps(pool, delta, 3);
  if (multi.length >= 2) {
    // Require the multi fit to actually explain most of the drag in linear
    // approx — reject noisy coupled-sensitivity explosions.
    let fx = 0;
    let fy = 0;
    for (const { s, dp } of multi) {
      fx += dp * s.sx;
      fy += dp * s.sy;
    }
    const multiExplained = 1 - Math.hypot(delta.x - fx, delta.y - fy) / deltaMag;
    if (multiExplained >= 0.75) {
      const built = buildParamEdits(project, branch, pipeline, multi, forceBreak);
      if (built !== null && verify(built.edits)) {
        return {
          kind: "param-edit",
          param: multi.map((c) => c.s.param).join("+"),
          newValue: built.primaryValue,
          edits: built.edits,
          verified: true,
          broke: built.broke.length > 0 ? built.broke : undefined,
        };
      }
      // Do not force-commit multi without verify: coupled hard constraints
      // make FD sensitivities non-orthogonal and multi-LS can invent noise.
    }
  }

  // Force-break without a verifying single/multi falls through to topology
  // re-tape in proposeMove (pin junction + axis-aware length re-tapes).
  return null;
}

/**
 * Propose the text edit implied by dragging `junction` to `target` (s64 coords)
 * while `branch` is checked out.
 *
 * Pass `{ forceBreak: true }` (Alt/⌥ drag) to allow rewriting measured params —
 * like re-taping a dimension by drag. Other hard constraints that then disagree
 * surface in the Review panel.
 */
export function proposeMove(
  project: Project,
  branch: string,
  junction: string,
  target: { x: S64; y: S64 },
  opts: MoveOpts = {},
): MoveProposal {
  const forceBreak = opts.forceBreak === true;
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

  // Soft params first; with forceBreak, measured params are candidates too
  // (before room-translate, so ⌥-drag means "re-tape this dimension" not
  // "slide the whole room").
  const paramHit = tryParamCandidates(
    project,
    branch,
    pipeline,
    sens,
    delta,
    deltaMag,
    forceBreak,
    (edits) => verifyMove(project, edits, branch, junction, targetIn),
  );
  if (paramHit !== null) {
    return withFinalizedDrag(project, branch, pipeline, paramHit, [junction]);
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
    // Under forceBreak, non-sw corners must not fall through to room
    // translate — ⌥ means "break the dimension", not "slide the room".
    if (
      roomEff?.stmt.kind === "room" &&
      (junction === `${roomKey}.sw` || (free.length === 0 && !forceBreak))
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
          return withFinalizedDrag(
            project,
            branch,
            pipeline,
            { kind: "room-move", room: roomKey, edits, verified: true },
            [junction],
          );
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
    const sketchEdits = junctionSketchEdits(project, branch, pipeline, junction, target);
    if (
      sketchEdits.length > 0 &&
      verifyMove(project, sketchEdits, branch, junction, targetIn)
    ) {
      return withFinalizedDrag(
        project,
        branch,
        pipeline,
        { kind: "sketch-edit", junction, edits: sketchEdits, verified: true },
        [junction],
      );
    }
  }

  // Force-break: ignore FD sensitivity (unreliable under hard locks). Drive
  // geometry from topology — pin the junction and re-tape every incident wall
  // length binding; demote measured params; drop incident meases.
  if (forceBreak) {
    const forced = forceBreakPinJunction(
      project,
      branch,
      pipeline,
      junction,
      target,
      targetIn,
    );
    if (forced !== null) {
      return withFinalizedDrag(project, branch, pipeline, forced, [junction]);
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
  const altHint = !forceBreak
    ? " — hold ⌥/Alt or ⌘ while dragging to break hard constraints"
    : "";
  return {
    kind: "refusal",
    blockers: [...blockers].sort(),
    message:
      blockers.size > 0
        ? `locked by ${[...blockers].sort().join(", ")}${altHint}`
        : `no free parameter or sketch explains this drag${roomHint}${altHint}`,
  };
}

/** Text edits that put a junction's sketch at `target` (s64). */
function junctionSketchEdits(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  junction: string,
  target: { x: S64; y: S64 },
): TextEdit[] {
  const eff = pipeline.resolved.effective.get(junction);
  if (eff?.stmt.kind !== "junction") return [];
  const updated: JunctionStmt = {
    ...eff.stmt,
    sketch: { x: target.x, y: target.y },
  };
  if (eff.layer === branch && eff.expandedFrom === undefined) {
    return [
      {
        kind: "replace-line",
        file: project.layers.get(branch)!.file,
        line: eff.stmt.loc.line,
        newText: printStmt(updated),
      },
    ];
  }
  return [
    {
      kind: "append",
      file: project.layers.get(branch)!.file,
      lines: [printStmt(updated)],
    },
  ];
}

/**
 * Force a junction to `targetIn` by pinning its sketch and re-taping every
 * incident length-bound param and meas to the distances implied by that pin
 * (other ends held at their current solved positions). Does not depend on
 * FD sensitivity, so it works when the model is fully measured / locked.
 */
function forceBreakPinJunction(
  project: Project,
  branch: string,
  pipeline: Pipeline,
  junction: string,
  target: { x: S64; y: S64 },
  targetIn: { x: number; y: number },
): MoveProposal | null {
  const edits: TextEdit[] = [...junctionSketchEdits(project, branch, pipeline, junction, target)];
  const broke: string[] = [];

  // Incident walls: rewrite length-bound params to the drop geometry.
  // Prefer axis-aligned span (|Δx| / |Δy|) so rect corners re-set width/depth
  // cleanly. Measured params are demoted to approximated (drag ≠ tape).
  const paramTargets = new Map<string, S64>();
  for (const [, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    if (eff.stmt.from !== junction && eff.stmt.to !== junction) continue;
    const other = eff.stmt.from === junction ? eff.stmt.to : eff.stmt.from;
    const otherPos = junctionPos(pipeline.solution, other);
    if (otherPos === null) continue;
    const axis = pipeline.resolved.effective.get(`${eff.stmt.name}.axis`);
    let newLen: number;
    if (axis?.stmt.kind === "axis" && axis.stmt.orient === "h") {
      newLen = Math.abs(targetIn.x - otherPos.x);
    } else if (axis?.stmt.kind === "axis" && axis.stmt.orient === "v") {
      newLen = Math.abs(targetIn.y - otherPos.y);
    } else {
      newLen = Math.hypot(targetIn.x - otherPos.x, targetIn.y - otherPos.y);
    }
    if (newLen < 1 / 64) continue;
    const bind = pipeline.resolved.effective.get(`${eff.stmt.name}.length`);
    if (bind?.stmt.kind !== "length") continue;
    const terms = bind.stmt.expr.terms;
    const first = terms[0];
    if (terms.length !== 1 || first === undefined || first.kind !== "ref" || first.sign !== 1) {
      continue;
    }
    paramTargets.set(first.name, s64FromInches(newLen));
  }
  for (const [param, value] of paramTargets) {
    const was = pipeline.resolved.effective.get(param);
    const pe = paramEditFor(project, branch, pipeline, param, value, true);
    if (pe === null) continue;
    edits.push(...pe);
    if (
      was &&
      (was.stmt.kind === "param" || was.stmt.kind === "set") &&
      was.stmt.prov === "measured"
    ) {
      broke.push(param);
    }
  }

  const strip = stripMeasesTouching(project, branch, pipeline, [junction]);
  edits.push(...strip.edits);
  broke.push(...strip.removed);

  if (edits.length === 0) return null;

  // Pin + demoted params encode the drag; dropped meases no longer claim tape truth.
  return {
    kind: "sketch-edit",
    junction,
    edits,
    verified: true,
    broke: [...new Set(broke)],
  };
}

/**
 * Translate a wall by `delta` (inches): both endpoints move together.
 * Same forceBreak semantics as proposeMove (Alt/⌥).
 */
export function proposeMoveWall(
  project: Project,
  branch: string,
  wallName: string,
  deltaInches: { x: number; y: number },
  opts: MoveOpts = {},
): MoveProposal {
  const forceBreak = opts.forceBreak === true;
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const wallEff = pipeline.resolved.effective.get(wallName);
  if (wallEff?.stmt.kind !== "wall") {
    return { kind: "refusal", blockers: [], message: `unknown wall "${wallName}"` };
  }
  const { from, to } = wallEff.stmt;
  const a0 = junctionPos(pipeline.solution, from);
  const b0 = junctionPos(pipeline.solution, to);
  if (a0 === null || b0 === null) {
    return { kind: "refusal", blockers: [], message: `wall "${wallName}" unresolved` };
  }
  const deltaMag = Math.hypot(deltaInches.x, deltaInches.y);
  if (deltaMag < 1 / 64) {
    return { kind: "wall-move", wall: wallName, edits: [], verified: true };
  }
  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const midT = { x: mid0.x + deltaInches.x, y: mid0.y + deltaInches.y };

  const sens = wallMidSensitivities(pipeline, from, to);
  const paramHit = tryParamCandidates(
    project,
    branch,
    pipeline,
    sens,
    deltaInches,
    deltaMag,
    forceBreak,
    (edits) =>
      verifyWallMove(project, edits, branch, from, to, midT, deltaInches),
  );
  if (paramHit !== null) {
    return withFinalizedDrag(
      project,
      branch,
      pipeline,
      {
        kind: "wall-move",
        wall: wallName,
        edits: paramHit.edits,
        verified: true,
        broke: paramHit.broke,
      },
      [from, to],
    );
  }

  // Room translate: both ends from the same rect room.
  const aEff = pipeline.resolved.effective.get(from);
  const bEff = pipeline.resolved.effective.get(to);
  if (
    aEff?.expandedFrom !== undefined &&
    aEff.expandedFrom === bEff?.expandedFrom
  ) {
    const roomKey = aEff.expandedFrom;
    const roomEff = pipeline.resolved.effective.get(roomKey);
    if (roomEff?.stmt.kind === "room") {
      const rs = roomEff.stmt;
      const updated: RoomRectStmt = {
        ...rs,
        at: {
          x: (rs.at?.x ?? 0) + s64FromInches(deltaInches.x),
          y: (rs.at?.y ?? 0) + s64FromInches(deltaInches.y),
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
        if (verifyWallMove(project, edits, branch, from, to, midT, deltaInches)) {
          return withFinalizedDrag(
            project,
            branch,
            pipeline,
            { kind: "wall-move", wall: wallName, edits, verified: true },
            [from, to],
          );
        }
      }
    }
  }

  // Sketch-translate both endpoints (and forceBreak rewrites as needed).
  const aTarget = {
    x: s64FromInches(a0.x + deltaInches.x),
    y: s64FromInches(a0.y + deltaInches.y),
  };
  const bTarget = {
    x: s64FromInches(b0.x + deltaInches.x),
    y: s64FromInches(b0.y + deltaInches.y),
  };
  // Move the free end first; for rigid walls the second follows via params.
  // Compose: try A with force, then B relative on the resulting project.
  const moveA = proposeMove(project, branch, from, aTarget, opts);
  if (moveA.kind !== "refusal" && moveA.edits.length >= 0 && moveA.verified) {
    let proj = moveA.edits.length > 0 ? applyEdits(project, moveA.edits) : project;
    const moveB = proposeMove(proj, branch, to, bTarget, opts);
    if (moveB.kind !== "refusal" && moveB.verified) {
      const edits = [...moveA.edits, ...moveB.edits];
      if (verifyWallMove(project, edits, branch, from, to, midT, deltaInches)) {
        const broke = [
          ...(moveA.broke ?? []),
          ...(moveB.broke ?? []),
        ];
        return withFinalizedDrag(
          project,
          branch,
          pipeline,
          {
            kind: "wall-move",
            wall: wallName,
            edits,
            verified: true,
            broke: broke.length > 0 ? [...new Set(broke)] : undefined,
          },
          [from, to],
        );
      }
    }
  }

  // Fall back: single-end move along the delta if the wall is axis-bound
  // (dragging a north wall north often only needs the free north junctions).
  const moveOne = proposeMove(project, branch, from, aTarget, opts);
  if (moveOne.kind !== "refusal" && moveOne.verified) {
    if (
      verifyWallMove(project, moveOne.edits, branch, from, to, midT, deltaInches)
    ) {
      return withFinalizedDrag(
        project,
        branch,
        pipeline,
        {
          kind: "wall-move",
          wall: wallName,
          edits: moveOne.edits,
          verified: true,
          broke: moveOne.broke,
        },
        [from, to],
      );
    }
  }

  // Force-break: pin both endpoints to translated positions via topology re-tape.
  if (forceBreak) {
    const moveAf = proposeMove(project, branch, from, aTarget, { forceBreak: true });
    if (moveAf.kind !== "refusal" && moveAf.edits.length > 0) {
      const mid = applyEdits(project, moveAf.edits);
      const moveBf = proposeMove(mid, branch, to, bTarget, { forceBreak: true });
      const edits = [
        ...moveAf.edits,
        ...(moveBf.kind !== "refusal" ? moveBf.edits : []),
      ];
      const broke = [
        ...(moveAf.broke ?? []),
        ...(moveBf.kind !== "refusal" ? (moveBf.broke ?? []) : []),
      ];
      if (edits.length > 0) {
        if (verifyWallMove(project, edits, branch, from, to, midT, deltaInches)) {
          return withFinalizedDrag(
            project,
            branch,
            pipeline,
            {
              kind: "wall-move",
              wall: wallName,
              edits,
              verified: true,
              broke: broke.length > 0 ? [...new Set(broke)] : undefined,
            },
            [from, to],
          );
        }
      }
    }
  }

  const blockers = new Set<string>();
  for (const s of sens) {
    if (s.prov === "measured" && Math.hypot(s.sx, s.sy) > SENS_TOL) blockers.add(s.param);
  }
  const altHint = !forceBreak
    ? " — hold ⌥/Alt or ⌘ while dragging to break hard constraints"
    : "";
  return {
    kind: "refusal",
    blockers: [...blockers].sort(),
    message:
      blockers.size > 0
        ? `wall locked by ${[...blockers].sort().join(", ")}${altHint}`
        : `no free parameter explains this wall drag${altHint}`,
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

/**
 * Endpoint of a drawn wall:
 * - free sketch point
 * - existing junction (shared topology)
 * - mid-wall T-join: project onto `onWall` and split the host there
 */
export type WallEndpoint =
  | { x: S64; y: S64 }
  | { existing: string }
  | { onWall: string; x: S64; y: S64 };

export interface AddWallProposal {
  edits: TextEdit[];
  wall: string;
  junctions: string[];
}

export interface SplitWallProposal {
  edits: TextEdit[];
  /** New mid-wall junction at the split. */
  junction: string;
  /** Host segment from original `from` → mid (reuses host name when possible). */
  wallA: string;
  /** Host segment from mid → original `to`. */
  wallB: string;
}

/** Refuse a split this close to either host endpoint (inches). */
const SPLIT_END_EPS_IN = 3;

/**
 * Split a host wall at a world point (projected onto the centerline).
 * Replaces the host with two collinear segments sharing a new T-junction,
 * retargets openings onto the correct segment, and drops whole-span length
 * bindings (partial spans no longer equal the room param).
 */
export function proposeSplitWall(
  project: Project,
  branch: string,
  wallName: string,
  at: { x: S64; y: S64 },
): SplitWallProposal {
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const wallEff = pipeline.resolved.effective.get(wallName);
  if (wallEff?.stmt.kind !== "wall") throw new Error(`no wall "${wallName}"`);
  const host = wallEff.stmt;
  const pa = pipelineJunction(pipeline, host.from);
  const pb = pipelineJunction(pipeline, host.to);
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 0.01) throw new Error(`wall "${wallName}" is degenerate`);
  const len = Math.sqrt(len2);
  const atIn = { x: at.x / 64, y: at.y / 64 };
  let t = ((atIn.x - pa.x) * vx + (atIn.y - pa.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const along = t * len;
  if (along < SPLIT_END_EPS_IN || along > len - SPLIT_END_EPS_IN) {
    throw new Error(
      `split point too close to an endpoint of ${wallName} (use the corner junction)`,
    );
  }
  const mx = pa.x + vx * t;
  const my = pa.y + vy * t;
  const midSketch = { x: s64FromInches(mx), y: s64FromInches(my) };

  // Names for mid junction and the second segment.
  const midJ = nextFreeName(project, `${wallName}.j`);
  const wallB = nextFreeName(project, `${wallName}.b`);
  const wallA = wallName; // reclaim host name for the from→mid stub

  const axisEff = pipeline.resolved.effective.get(`${wallName}.axis`);
  const orient =
    axisEff?.stmt.kind === "axis" ? axisEff.stmt.orient : undefined;

  // 1) Remove host wall + whole-span bindings (length no longer applies to either stub).
  //    Do not unsplit: this delete is a replace-with-stubs, and the host may itself be
  //    a T-stem whose parent must stay split.
  const edits: TextEdit[] = [
    ...proposeDelete(project, branch, wallName, { unsplit: false }),
  ];

  // 2) Mid junction + two stubs (+ axes if the host was axis-aligned).
  const lines: string[] = [];
  lines.push(
    printStmt({
      kind: "junction",
      name: midJ,
      sketch: midSketch,
      loc: { file: "", line: 0 },
      leadingComments: [],
    }),
  );
  lines.push(
    printStmt({
      kind: "wall",
      name: wallA,
      from: host.from,
      to: midJ,
      wallType: host.wallType,
      loc: { file: "", line: 0 },
      leadingComments: [],
    }),
  );
  lines.push(
    printStmt({
      kind: "wall",
      name: wallB,
      from: midJ,
      to: host.to,
      wallType: host.wallType,
      loc: { file: "", line: 0 },
      leadingComments: [],
    }),
  );
  if (orient !== undefined) {
    lines.push(
      printStmt({
        kind: "axis",
        name: `${wallA}.axis`,
        wall: wallA,
        orient,
        loc: { file: "", line: 0 },
        leadingComments: [],
      }),
    );
    lines.push(
      printStmt({
        kind: "axis",
        name: `${wallB}.axis`,
        wall: wallB,
        orient,
        loc: { file: "", line: 0 },
        leadingComments: [],
      }),
    );
  }

  // 3) Re-host openings that lived on the old wall onto the correct stub.
  //    Measure near-jamb distance from host.from; assign by center.
  for (const [, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "opening" || eff.stmt.wall !== wallName) continue;
    const op = eff.stmt;
    const offIn = evalExprOffset(op, pipeline) / 64;
    const wIn = op.width / 64;
    const fromAnchored = op.anchor === host.from;
    const startFromFrom = fromAnchored ? offIn : len - offIn - wIn;
    const center = startFromFrom + wIn / 2;
    const onA = center <= along;
    const newWall = onA ? wallA : wallB;
    const newAnchor = onA ? host.from : midJ;
    const newStart = Math.max(0, Math.round(onA ? startFromFrom : startFromFrom - along));
    const updated: OpeningStmt = {
      ...op,
      wall: newWall,
      anchor: newAnchor,
      offset: { terms: [{ sign: 1, kind: "lit", value: s64FromInches(newStart) }] },
    };
    if (eff.layer === branch && eff.expandedFrom === undefined) {
      edits.push({
        kind: "replace-line",
        file: project.layers.get(branch)!.file,
        line: op.loc.line,
        newText: printStmt(updated),
      });
    } else {
      lines.push(printStmt(updated));
    }
  }

  edits.push({ kind: "append", file: project.layers.get(branch)!.file, lines });
  return { edits, junction: midJ, wallA, wallB };
}

/** Offset of an opening in S64, evaluating any param refs. */
function evalExprOffset(op: OpeningStmt, pipeline: Pipeline): S64 {
  const params = new Map<string, S64>();
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "param" || eff.stmt.kind === "set") {
      params.set(key, eff.stmt.value);
    }
  }
  let total = 0;
  for (const t of op.offset.terms) {
    if (t.kind === "lit") total += t.sign * t.value;
    else {
      const v = params.get(t.name);
      if (v === undefined) throw new Error(`opening ${op.name}: unknown param ${t.name}`);
      total += t.sign * v;
    }
  }
  return total;
}

/** First free name among `prefix`, `prefix1`, `prefix2`, … */
function nextFreeName(project: Project, prefix: string): string {
  const used = collectNames(project);
  if (!used.has(prefix)) return prefix;
  for (let n = 1; ; n++) {
    const c = `${prefix}${n}`;
    if (!used.has(c)) return c;
  }
}

function collectNames(project: Project): Set<string> {
  const used = new Set<string>();
  for (const [, l] of project.layers) {
    for (const s of l.parsed.stmts) {
      const key = stmtKey(s);
      if (key !== null) used.add(key);
    }
  }
  return used;
}

/**
 * Draw a wall: new junctions for free endpoints, reuse for `existing` ones,
 * auto-split host walls for mid-wall T-joins (`onWall`). An `axis` constraint
 * is emitted when the UI snapped the wall to an axis.
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

  // Resolve T-joins first so subsequent free names and topology see the splits.
  let cur = project;
  const edits: TextEdit[] = [];
  const resolveEnd = (end: WallEndpoint): string | { x: S64; y: S64 } => {
    if ("existing" in end) return end.existing;
    if ("onWall" in end) {
      const split = proposeSplitWall(cur, branch, end.onWall, { x: end.x, y: end.y });
      edits.push(...split.edits);
      cur = applyEdits(cur, split.edits);
      return split.junction;
    }
    return { x: end.x, y: end.y };
  };
  const endA = resolveEnd(args.a);
  const endB = resolveEnd(args.b);

  const lines: string[] = [];
  const created: string[] = [];
  const junctionNames: string[] = [];
  let counter = 0;
  const p = args.ns !== undefined ? `${args.ns}.` : "";
  const jPrefix = `${p}j`;
  const wPrefix = `${p}w`;

  for (const end of [endA, endB]) {
    if (typeof end === "string") {
      junctionNames.push(end);
    } else {
      let name = genName(cur, jPrefix);
      while (created.includes(name) || junctionNames.includes(name)) {
        counter += 1;
        name = `${jPrefix}${parseInt(name.slice(jPrefix.length), 10) + counter}`;
      }
      created.push(name);
      junctionNames.push(name);
      lines.push(
        printStmt({
          kind: "junction",
          name,
          sketch: { x: end.x, y: end.y },
          loc: { file: "", line: 0 },
          leadingComments: [],
        }),
      );
    }
  }

  let wallName = genName(cur, wPrefix);
  while (created.includes(wallName) || wallName === junctionNames[0] || wallName === junctionNames[1]) {
    wallName = `${wPrefix}${parseInt(wallName.slice(wPrefix.length), 10) + 1}`;
  }
  lines.push(
    printStmt({
      kind: "wall",
      name: wallName,
      from: junctionNames[0]!,
      to: junctionNames[1]!,
      wallType: args.wallType,
      loc: { file: "", line: 0 },
      leadingComments: [],
    }),
  );

  if (args.axis !== undefined) {
    lines.push(
      printStmt({
        kind: "axis",
        name: `${wallName}.axis`,
        wall: wallName,
        orient: args.axis,
        loc: { file: "", line: 0 },
        leadingComments: [],
      }),
    );
  }

  edits.push({ kind: "append", file: file.file, lines });
  return {
    edits,
    wall: wallName,
    junctions: junctionNames,
  };
}

/**
 * Delete an element. Own authored lines are blanked; inherited or
 * template-expanded statements get tombstones. Deleting a wall also removes
 * its companion `.length`/`.axis` statements so no dangling refs remain.
 */
/**
 * Freeze the visible geometry: rewrite free junction sketches (and soft param
 * targets) to the current solve so a subsequent topology edit does not let the
 * soft regularizer drag the plan to a new compromise.
 *
 * Expanded junctions are pierced by authoring an explicit `junction` on the
 * branch (expansion skips keys that already exist).
 */
export function proposeBakeSolvedPose(
  project: Project,
  branch: string,
  pipeline?: Pipeline,
): TextEdit[] {
  const pipe = pipeline ?? resolveAndSolve(layerMap(project), branch);
  const file = project.layers.get(branch);
  if (file === undefined) throw new Error(`no layer "${branch}"`);

  const BAKE_TOL = 1 / 32; // inches
  const edits: TextEdit[] = [];
  const append: string[] = [];

  // Soft params → solved value (same provenance). Hard measured stay put.
  for (const [key, eff] of pipe.resolved.effective) {
    if (eff.stmt.kind !== "param" && eff.stmt.kind !== "set") continue;
    if (eff.stmt.prov === "measured") continue;
    const solved = pipe.solution.system.varIndex.get(`p:${key}`);
    if (solved === undefined) continue;
    const solvedIn = pipe.solution.x[solved]!;
    const authoredIn = eff.stmt.value / 64;
    if (Math.abs(solvedIn - authoredIn) <= BAKE_TOL) continue;
    const newVal = s64FromInches(solvedIn);
    try {
      edits.push(
        ...proposeSetParam(project, branch, key, newVal, eff.stmt.prov, eff.stmt.date),
      );
    } catch {
      // ignore uneditable
    }
  }

  for (const [key, eff] of pipe.resolved.effective) {
    if (eff.stmt.kind !== "junction") continue;
    const pos = junctionPos(pipe.solution, key);
    if (pos === null) continue;
    const sk = eff.stmt.sketch;
    const sx = sk.x / 64;
    const sy = sk.y / 64;
    if (Math.abs(pos.x - sx) <= BAKE_TOL && Math.abs(pos.y - sy) <= BAKE_TOL) continue;

    const updated: JunctionStmt = {
      kind: "junction",
      name: key,
      sketch: { x: s64FromInches(pos.x), y: s64FromInches(pos.y) },
      loc: { file: "", line: 0 },
      leadingComments: [],
    };
    // Own authored free junction: rewrite in place. Expanded / inherited: pierce.
    if (eff.expandedFrom === undefined && eff.layer === branch) {
      edits.push({
        kind: "replace-line",
        file: file.file,
        line: eff.stmt.loc.line,
        newText: printStmt(updated),
      });
    } else {
      append.push(printStmt(updated));
    }
  }

  if (append.length > 0) {
    edits.push({ kind: "append", file: file.file, lines: append });
  }
  return edits;
}

/** Walls that use `junction` as an endpoint (effective names). */
function wallsAtJunction(pipeline: Pipeline, junction: string): string[] {
  const out: string[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    if (eff.stmt.from === junction || eff.stmt.to === junction) out.push(key);
  }
  return out;
}

function wallOtherEnd(wall: WallStmt, junction: string): string {
  if (wall.from === junction) return wall.to;
  if (wall.to === junction) return wall.from;
  throw new Error(`wall "${wall.name}" does not meet "${junction}"`);
}

function wallLengthInches(pipeline: Pipeline, wallName: string): number {
  const eff = pipeline.resolved.effective.get(wallName);
  if (eff?.stmt.kind !== "wall") return 0;
  const a = junctionPos(pipeline.solution, eff.stmt.from);
  const b = junctionPos(pipeline.solution, eff.stmt.to);
  if (a === null || b === null) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * True when W1 and W2 meet at `junction` and their other ends are nearly
 * collinear through it (opposite directions along one centerline).
 */
function collinearThroughJunction(
  pipeline: Pipeline,
  junction: string,
  w1: string,
  w2: string,
): boolean {
  const e1 = pipeline.resolved.effective.get(w1);
  const e2 = pipeline.resolved.effective.get(w2);
  if (e1?.stmt.kind !== "wall" || e2?.stmt.kind !== "wall") return false;
  const j = junctionPos(pipeline.solution, junction);
  const a = junctionPos(pipeline.solution, wallOtherEnd(e1.stmt, junction));
  const b = junctionPos(pipeline.solution, wallOtherEnd(e2.stmt, junction));
  if (j === null || a === null || b === null) return false;
  const v1x = a.x - j.x;
  const v1y = a.y - j.y;
  const v2x = b.x - j.x;
  const v2y = b.y - j.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 0.01 || n2 < 0.01) return false;
  // Opposite directions along a line → unit vectors nearly anti-parallel.
  const dot = (v1x / n1) * (v2x / n2) + (v1y / n1) * (v2y / n2);
  return dot < -0.95;
}

/** Prefer the "A" stub name (host reclaim) over `.b` / `.bN` when merging. */
function preferMergedWallName(a: string, b: string): string {
  if (b === `${a}.b` || b.startsWith(`${a}.b`)) return a;
  if (a === `${b}.b` || a.startsWith(`${b}.b`)) return b;
  return a.length <= b.length ? a : b;
}

/**
 * If `stem` is the non-collinear leg of a T at `junction`, return the two
 * collinear host stubs to merge when the stem is deleted.
 */
function collinearPairAtT(
  pipeline: Pipeline,
  junction: string,
  stem: string,
): { a: string; b: string } | null {
  const others = wallsAtJunction(pipeline, junction).filter((w) => w !== stem);
  if (others.length !== 2) return null;
  const [w1, w2] = others as [string, string];
  if (!collinearThroughJunction(pipeline, junction, w1, w2)) return null;
  return { a: w1, b: w2 };
}

/**
 * Delete an element. Own authored lines are blanked; inherited or
 * template-expanded statements get tombstones. Deleting a wall also removes
 * its companion `.length`/`.axis` statements so no dangling refs remain.
 *
 * Before removing geometry, the current solved pose is baked into sketches /
 * soft params so the re-solve after delete does not drift the rest of the plan
 * toward a new soft compromise ("delete should change nothing else").
 *
 * Deleting the stem of a T-join unsplits the host: the mid junction and two
 * collinear stubs merge back into one wall. Pass `{ unsplit: false }` when
 * removing a wall only to replace it (e.g. proposeSplitWall) — otherwise a
 * T-stem being split would wrongly unsplit its parent and vanish.
 */
export function proposeDelete(
  project: Project,
  branch: string,
  key: string,
  opts: { unsplit?: boolean } = {},
): TextEdit[] {
  const doUnsplit = opts.unsplit !== false;
  // Snapshot pose while the deleted element still constrains the model.
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const resolved = pipeline.resolved;
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

  // If deleting a wall, also delete all openings hosted on it — and unsplit
  // any T-join mid where this wall is the stem (unless caller opts out).
  const appendLines: string[] = [];
  if (eff?.stmt.kind === "wall") {
    for (const [openingKey, openingEff] of resolved.effective) {
      if (openingEff.stmt.kind === "opening" && openingEff.stmt.wall === key) {
        if (!targets.includes(openingKey)) {
          targets.push(openingKey);
        }
      }
    }

    if (doUnsplit) {
      for (const mid of [eff.stmt.from, eff.stmt.to]) {
        const pair = collinearPairAtT(pipeline, mid, key);
        if (pair === null) continue;
        const eA = resolved.effective.get(pair.a);
        const eB = resolved.effective.get(pair.b);
        if (eA?.stmt.kind !== "wall" || eB?.stmt.kind !== "wall") continue;
        const outerA = wallOtherEnd(eA.stmt, mid);
        const outerB = wallOtherEnd(eB.stmt, mid);
        const mergedName = preferMergedWallName(pair.a, pair.b);
        const wallType = eA.stmt.wallType;

        for (const stub of [pair.a, pair.b]) {
          for (const k of [stub, `${stub}.length`, `${stub}.axis`]) {
            if (resolved.effective.has(k) && !targets.includes(k)) targets.push(k);
          }
          for (const [openingKey, openingEff] of resolved.effective) {
            if (openingEff.stmt.kind === "opening" && openingEff.stmt.wall === stub) {
              if (!targets.includes(openingKey)) targets.push(openingKey);
            }
          }
        }
        if (resolved.effective.has(mid) && !targets.includes(mid)) {
          targets.push(mid);
        }

        // Rebuild openings on the merged wall (offset from outerA along the span).
        const pa = pipelineJunction(pipeline, outerA);
        for (const stub of [pair.a, pair.b]) {
          const stubEff = resolved.effective.get(stub);
          if (stubEff?.stmt.kind !== "wall") continue;
          const stubFrom = stubEff.stmt.from;
          const stubLenView = wallLengthInches(pipeline, stub);
          for (const [, opEff] of resolved.effective) {
            if (opEff.stmt.kind !== "opening" || opEff.stmt.wall !== stub) continue;
            const op = opEff.stmt;
            const offIn = evalExprOffset(op, pipeline) / 64;
            const wIn = op.width / 64;
            const fromAnchored = op.anchor === stubFrom;
            const startFromStubFrom = fromAnchored ? offIn : stubLenView - offIn - wIn;
            const stubFromPos = pipelineJunction(pipeline, stubFrom);
            const stubFromAlong = Math.hypot(stubFromPos.x - pa.x, stubFromPos.y - pa.y);
            const stubTo = stubEff.stmt.to;
            const stubToPos = pipelineJunction(pipeline, stubTo);
            const stubToAlong = Math.hypot(stubToPos.x - pa.x, stubToPos.y - pa.y);
            const alongIncreases = stubToAlong >= stubFromAlong;
            const startAlong = alongIncreases
              ? stubFromAlong + startFromStubFrom
              : stubFromAlong - startFromStubFrom - wIn;
            const clamped = Math.max(0, Math.round(startAlong));
            appendLines.push(
              printStmt({
                ...op,
                wall: mergedName,
                anchor: outerA,
                offset: {
                  terms: [{ sign: 1, kind: "lit", value: s64FromInches(clamped) }],
                },
              }),
            );
          }
        }

        appendLines.push(
          printStmt({
            kind: "wall",
            name: mergedName,
            from: outerA,
            to: outerB,
            wallType,
            loc: { file: "", line: 0 },
            leadingComments: [],
          }),
        );
        const axisA = resolved.effective.get(`${pair.a}.axis`);
        const axisB = resolved.effective.get(`${pair.b}.axis`);
        const orient =
          axisA?.stmt.kind === "axis"
            ? axisA.stmt.orient
            : axisB?.stmt.kind === "axis"
              ? axisB.stmt.orient
              : undefined;
        if (orient !== undefined) {
          appendLines.push(
            printStmt({
              kind: "axis",
              name: `${mergedName}.axis`,
              wall: mergedName,
              orient,
              loc: { file: "", line: 0 },
              leadingComments: [],
            }),
          );
        }
      }
    }
  }

  // Only bake when removing real geometry (walls / openings / fixtures / junctions),
  // not when tombstoning a lone .length / .axis for trapezoid relax.
  const bakeGeometry =
    eff !== undefined &&
    (eff.stmt.kind === "wall" ||
      eff.stmt.kind === "opening" ||
      eff.stmt.kind === "fixture" ||
      eff.stmt.kind === "junction" ||
      eff.stmt.kind === "meas");

  const edits: TextEdit[] = bakeGeometry
    ? [...proposeBakeSolvedPose(project, branch, pipeline)]
    : [];
  // Bake may have rewritten lines; re-resolve ownership against original project
  // is fine — bake either replaced sketches (same lines) or appended pierces.
  // Delete targets still refer to pre-bake statement locations for owned walls.
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
  if (appendLines.length > 0) {
    edits.push({
      kind: "append",
      file: project.layers.get(branch)!.file,
      lines: appendLines,
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
