/**
 * Face-referenced measurement helpers.
 *
 * Centerline is the solver's canonical space. A tape read M along a wall run
 * relates to centerline length C by the crossing walls at each end:
 *
 *   M = C + eA·½tA + eB·½tB
 *
 * where e = −1 (inner), 0 (centerline), +1 (outer), and t is the thickness of
 * the wall that meets the span at that junction (the "crossing" wall).
 */

import type { FaceEnd, FaceRef, WallStmt } from "./ast";
import type { Resolved } from "./merge";

export function faceSign(end: FaceEnd): -1 | 0 | 1 {
  if (end === "inner") return -1;
  if (end === "outer") return 1;
  return 0;
}

export function isCenterlineRef(ref: FaceRef | undefined): boolean {
  if (ref === undefined) return true;
  return ref.a === "centerline" && ref.b === "centerline";
}

export function normalizeFaceRef(
  ref: FaceEnd | FaceRef | undefined,
): FaceRef | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") {
    if (ref === "centerline") return undefined;
    return { a: ref, b: ref };
  }
  if (ref.a === "centerline" && ref.b === "centerline") return undefined;
  return ref;
}

/** Parse `inner` / `outer` / `centerline` / `inner, outer` (a then b). */
export function parseFaceRefText(text: string): FaceRef {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length === 1) {
    const e = parseFaceEnd(parts[0]!);
    return { a: e, b: e };
  }
  if (parts.length === 2) {
    return { a: parseFaceEnd(parts[0]!), b: parseFaceEnd(parts[1]!) };
  }
  throw new Error(`bad face ref "${text}" (expected e.g. inner or inner, outer)`);
}

export function parseFaceEnd(text: string): FaceEnd {
  const t = text.trim();
  if (t === "inner" || t === "outer" || t === "centerline") return t;
  throw new Error(`bad face end "${text}" (inner | outer | centerline)`);
}

export function formatFaceRef(ref: FaceRef): string {
  if (ref.a === ref.b) return ref.a;
  return `${ref.a}, ${ref.b}`;
}

/** Walls incident to a junction. */
export function wallsAtJunction(resolved: Resolved, junction: string): WallStmt[] {
  const out: WallStmt[] = [];
  for (const [, eff] of resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    if (eff.stmt.from === junction || eff.stmt.to === junction) out.push(eff.stmt);
  }
  return out;
}

/** Wall whose endpoints are exactly a and b (either order), if any. */
export function wallBetween(
  resolved: Resolved,
  a: string,
  b: string,
): WallStmt | null {
  for (const [, eff] of resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    const { from, to } = eff.stmt;
    if ((from === a && to === b) || (from === b && to === a)) return eff.stmt;
  }
  return null;
}

/**
 * Crossing walltype at a junction for a span along `spanWall` (or free span).
 * Deterministic for L-corners (degree 2) and simple T-ends (degree 3 picks the
 * most orthogonal other wall). X-junctions and free diagonals return null —
 * treat the end as centerline (no thickness term) unless the author used an
 * explicit expression elsewhere.
 */
export function crossingWallType(
  resolved: Resolved,
  junction: string,
  spanWall: string | null,
): string | null {
  const incident = wallsAtJunction(resolved, junction);
  const others =
    spanWall === null
      ? incident
      : incident.filter((w) => w.name !== spanWall);

  if (others.length === 0) return null;
  if (others.length === 1) return others[0]!.wallType;

  // Degree ≥ 3: pick the other wall most orthogonal to the span, when we have
  // sketch positions to compare. Fall back to lexicographically first type.
  if (spanWall !== null) {
    const span = resolved.effective.get(spanWall);
    if (span?.stmt.kind === "wall") {
      const spanDir = wallSketchDir(resolved, span.stmt);
      if (spanDir !== null) {
        let best: WallStmt | null = null;
        let bestScore = -1;
        for (const w of others) {
          const d = wallSketchDir(resolved, w);
          if (d === null) continue;
          // |sin θ| via 2D cross magnitude of unit-ish directions
          const cross = Math.abs(spanDir.x * d.y - spanDir.y * d.x);
          if (cross > bestScore) {
            bestScore = cross;
            best = w;
          }
        }
        if (best !== null && bestScore > 0.1) return best.wallType;
      }
    }
  }

  // Ambiguous: refuse thickness contribution (safer than guessing wrong).
  return null;
}

function wallSketchDir(
  resolved: Resolved,
  wall: WallStmt,
): { x: number; y: number } | null {
  const a = resolved.effective.get(wall.from);
  const b = resolved.effective.get(wall.to);
  if (a?.stmt.kind !== "junction" || b?.stmt.kind !== "junction") return null;
  const dx = b.stmt.sketch.x - a.stmt.sketch.x;
  const dy = b.stmt.sketch.y - a.stmt.sketch.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  return { x: dx / len, y: dy / len };
}

/**
 * Half-thickness contributions at each end of a span (inches), given solved
 * or target thicknesses. Missing / centerline ends contribute 0.
 *
 * Returns the additive terms for residual form:
 *   C + eA·½tA + eB·½tB − M  = 0
 * so callers use +sign * halfT on each end.
 */
export function faceHalfTerms(
  resolved: Resolved,
  a: string,
  b: string,
  ref: FaceRef | undefined,
  thicknessOf: (wallType: string) => number,
): { eA: -1 | 0 | 1; eB: -1 | 0 | 1; tA: number; tB: number; typeA: string | null; typeB: string | null } {
  if (isCenterlineRef(ref)) {
    return { eA: 0, eB: 0, tA: 0, tB: 0, typeA: null, typeB: null };
  }
  const r = ref!;
  const span = wallBetween(resolved, a, b);
  const spanName = span?.name ?? null;
  const typeA =
    faceSign(r.a) === 0 ? null : crossingWallType(resolved, a, spanName);
  const typeB =
    faceSign(r.b) === 0 ? null : crossingWallType(resolved, b, spanName);
  return {
    eA: faceSign(r.a),
    eB: faceSign(r.b),
    tA: typeA !== null ? thicknessOf(typeA) : 0,
    tB: typeB !== null ? thicknessOf(typeB) : 0,
    typeA,
    typeB,
  };
}

/** Inner / centerline / outer length of a wall from solved centerline + thicknesses. */
export function faceLengthsOfWall(
  centerlineInches: number,
  halfA: number,
  halfB: number,
): { inner: number; centerline: number; outer: number } {
  return {
    inner: centerlineInches - halfA - halfB,
    centerline: centerlineInches,
    outer: centerlineInches + halfA + halfB,
  };
}

/**
 * World positions where a face-referenced tape's ends land (for drawing).
 *
 * Centerline (or missing) ref → the two junctions unchanged.
 * Inner → each end is pulled in along the span by ½ of the crossing wall's
 * thickness (the tape stops at that wall's near face, not at the centerline
 * junction). Outer → pushed out by the same amount.
 *
 * When the span is a real wall and `interiorHint` is given (e.g. plan centroid),
 * endpoints are also shifted onto that wall's corresponding face so the
 * dimension sits on the surface you actually taped, not the centerline stroke.
 */
export function faceMeasureEndpoints(
  resolved: Resolved,
  getJunction: (name: string) => { x: number; y: number } | null,
  thicknessOf: (wallType: string) => number,
  aName: string,
  bName: string,
  ref: FaceRef | undefined,
  interiorHint?: { x: number; y: number },
): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
  const ja = getJunction(aName);
  const jb = getJunction(bName);
  if (ja === null || jb === null) return null;
  if (isCenterlineRef(ref)) return { a: { ...ja }, b: { ...jb } };

  const dx = jb.x - ja.x;
  const dy = jb.y - ja.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { a: { ...ja }, b: { ...jb } };
  const ux = dx / len;
  const uy = dy / len;

  const span = wallBetween(resolved, aName, bName);
  const spanName = span?.name ?? null;
  const r = ref!;
  const typeA = faceSign(r.a) === 0 ? null : crossingWallType(resolved, aName, spanName);
  const typeB = faceSign(r.b) === 0 ? null : crossingWallType(resolved, bName, spanName);
  const halfA = typeA !== null ? thicknessOf(typeA) / 2 : 0;
  const halfB = typeB !== null ? thicknessOf(typeB) / 2 : 0;

  // Along-span: inner pulls ends toward midspan; outer pushes past the junction.
  let ax = ja.x;
  let ay = ja.y;
  let bx = jb.x;
  let by = jb.y;
  if (faceSign(r.a) === -1) {
    ax += ux * halfA;
    ay += uy * halfA;
  } else if (faceSign(r.a) === 1) {
    ax -= ux * halfA;
    ay -= uy * halfA;
  }
  if (faceSign(r.b) === -1) {
    bx -= ux * halfB;
    by -= uy * halfB;
  } else if (faceSign(r.b) === 1) {
    bx += ux * halfB;
    by += uy * halfB;
  }

  // Onto the span wall's face (skip free diagonals / unknown span).
  if (span !== null && interiorHint !== undefined) {
    let nx = -uy;
    let ny = ux;
    const midX = (ja.x + jb.x) / 2;
    const midY = (ja.y + jb.y) / 2;
    // Point nx toward the interior hint.
    if (nx * (interiorHint.x - midX) + ny * (interiorHint.y - midY) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const halfSpan = thicknessOf(span.wallType) / 2;
    const perp = (end: FaceEnd): number => {
      const s = faceSign(end);
      if (s === -1) return halfSpan; // inner face
      if (s === 1) return -halfSpan; // outer face
      return 0;
    };
    const sa = perp(r.a);
    const sb = perp(r.b);
    ax += nx * sa;
    ay += ny * sa;
    bx += nx * sb;
    by += ny * sb;
  }

  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
