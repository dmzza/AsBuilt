import sharp from "sharp";
import {
  dist,
  edgeMap,
  imageSize,
  inkBBox,
  inkCentroid,
  inkMask,
  mid,
  toRgba,
} from "./image";
import type { DimReading, Point, SimilarityTransform } from "./types";

/** Apply similarity: p' = R(scale * p) + t  (candidate → reference space). */
export function applyTransform(p: Point, t: SimilarityTransform): Point {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const x = t.scale * p.x;
  const y = t.scale * p.y;
  return { x: c * x - s * y + t.tx, y: s * x + c * y + t.ty };
}

export function invertTransform(t: SimilarityTransform): SimilarityTransform {
  // p' = R(s p) + t  =>  p = (1/s) R^T (p' - t)
  const c = Math.cos(-t.rotation);
  const s = Math.sin(-t.rotation);
  const invS = 1 / t.scale;
  return {
    scale: invS,
    rotation: -t.rotation,
    tx: invS * (c * -t.tx - s * -t.ty),
    ty: invS * (s * -t.tx + c * -t.ty),
  };
}

function normalizeAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/**
 * Angle in (-π/4, π/4] that best aligns strong edges to image H/V.
 * Floor plans are mostly orthogonal — do NOT use PCA of ink-cloud shape
 * (irregular footprints invent a fake diagonal "principal axis").
 */
export function orthogonalFrameAngle(
  width: number,
  height: number,
  rgba: Buffer,
): number {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    gray[i] =
      0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0);
  }

  // Undirected edge orientation histogram over [0, π).
  const bins = 180;
  const hist = new Float64Array(bins);
  const step = 2;
  const magThresh = 40;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = y * width + x;
      const gx =
        -(gray[i - width - 1] ?? 0) +
        (gray[i - width + 1] ?? 0) -
        2 * (gray[i - 1] ?? 0) +
        2 * (gray[i + 1] ?? 0) -
        (gray[i + width - 1] ?? 0) +
        (gray[i + width + 1] ?? 0);
      const gy =
        -(gray[i - width - 1] ?? 0) -
        2 * (gray[i - width] ?? 0) -
        (gray[i - width + 1] ?? 0) +
        (gray[i + width - 1] ?? 0) +
        2 * (gray[i + width] ?? 0) +
        (gray[i + width + 1] ?? 0);
      const mag = Math.hypot(gx, gy);
      if (mag < magThresh) continue;
      // Edge direction is perpendicular to gradient; fold to [0, π).
      let ang = Math.atan2(gy, gx) + Math.PI / 2;
      while (ang < 0) ang += Math.PI;
      while (ang >= Math.PI) ang -= Math.PI;
      const b = Math.min(bins - 1, Math.floor((ang / Math.PI) * bins));
      hist[b] = (hist[b] ?? 0) + mag;
    }
  }

  // Score frames θ ∈ (-π/4, π/4]: energy near θ and θ+π/2 (orthogonal walls).
  let best = 0;
  let bestScore = -1;
  for (let deg = -44; deg <= 45; deg++) {
    const theta = (deg * Math.PI) / 180;
    let score = 0;
    for (const offset of [0, Math.PI / 2]) {
      let a = theta + offset;
      while (a < 0) a += Math.PI;
      while (a >= Math.PI) a -= Math.PI;
      const center = (a / Math.PI) * bins;
      for (let d = -3; d <= 3; d++) {
        const b = Math.round(center + d);
        const idx = ((b % bins) + bins) % bins;
        const w = 1 - Math.abs(d) / 4;
        score += w * (hist[idx] ?? 0);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = theta;
    }
  }
  // Snap tiny deskew noise to 0
  if (Math.abs(best) < 0.02) return 0;
  return best;
}

function transformFromBBoxes(
  rb: { x: number; y: number; w: number; h: number },
  cb: { x: number; y: number; w: number; h: number },
  rc: Point,
  cc: Point,
  rotation: number,
): SimilarityTransform {
  const absR = Math.abs(normalizeAngle(rotation));
  const near90 = Math.abs(absR - Math.PI / 2) < 0.25;
  const cw = near90 ? cb.h : cb.w;
  const ch = near90 ? cb.w : cb.h;
  const scaleX = rb.w / Math.max(1, cw);
  const scaleY = rb.h / Math.max(1, ch);
  const scale = (scaleX + scaleY) / 2;

  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const cx = scale * cc.x;
  const cy = scale * cc.y;
  const rx = c * cx - s * cy;
  const ry = s * cx + c * cy;
  return {
    scale,
    rotation,
    tx: rc.x - rx,
    ty: rc.y - ry,
  };
}

/** Downsample edge mask for cheap alignment hypothesis scoring. */
function downEdgeMask(
  width: number,
  height: number,
  rgba: Buffer,
  maxSide = 256,
): { w: number; h: number; mask: Uint8Array; sx: number; sy: number } {
  const edges = edgeMap(width, height, rgba);
  const scale = maxSide / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const mask = new Uint8Array(w * h);
  const thresh = 35;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const sy = Math.min(height - 1, Math.floor(y / scale));
      if ((edges[sy * width + sx] ?? 0) >= thresh) mask[y * w + x] = 1;
    }
  }
  return { w, h, mask, sx: scale, sy: scale };
}

function scoreEdgeAgreement(
  ref: { w: number; h: number; mask: Uint8Array },
  cand: { w: number; h: number; mask: Uint8Array },
  t: SimilarityTransform,
  refScale: number,
  candScale: number,
): number {
  // Map transform from full-res into downsampled space:
  // p_ref_full = R(s p_cand_full) + t
  // p_ref_ds = refScale * p_ref_full
  // p_cand_full = p_cand_ds / candScale
  const s = t.scale * (refScale / candScale);
  const c = Math.cos(t.rotation);
  const sn = Math.sin(t.rotation);
  const tx = t.tx * refScale;
  const ty = t.ty * refScale;

  let agree = 0;
  let candOnly = 0;
  const radius = 2;
  for (let y = 0; y < cand.h; y++) {
    for (let x = 0; x < cand.w; x++) {
      if (!cand.mask[y * cand.w + x]) continue;
      const rx = c * (s * x) - sn * (s * y) + tx;
      const ry = sn * (s * x) + c * (s * y) + ty;
      const ix = Math.round(rx);
      const iy = Math.round(ry);
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = ix + dx;
          const yy = iy + dy;
          if (xx < 0 || yy < 0 || xx >= ref.w || yy >= ref.h) continue;
          if (ref.mask[yy * ref.w + xx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) agree++;
      else candOnly++;
    }
  }
  let refEdges = 0;
  for (let i = 0; i < ref.mask.length; i++) if (ref.mask[i]) refEdges++;
  const denom = agree + candOnly + refEdges;
  if (denom === 0) return 0;
  // Dice-like: reward overlap, penalize both misses and extras
  return (2 * agree) / denom;
}

/**
 * Align candidate to reference via similarity transform.
 * Rotation from orthogonal wall-edge frames + discrete page-rotation hypotheses,
 * scored by downsampled edge agreement (not PCA of ink cloud).
 */
export async function estimateSimilarityTransform(
  referencePng: Buffer,
  candidatePng: Buffer,
): Promise<SimilarityTransform> {
  const [ref, cand] = await Promise.all([toRgba(referencePng), toRgba(candidatePng)]);
  const refMask = inkMask(ref.width, ref.height, ref.data);
  const candMask = inkMask(cand.width, cand.height, cand.data);
  const rb = inkBBox(ref.width, ref.height, refMask);
  const cb = inkBBox(cand.width, cand.height, candMask);
  const rc = inkCentroid(ref.width, ref.height, refMask);
  const cc = inkCentroid(cand.width, cand.height, candMask);

  const refFrame = orthogonalFrameAngle(ref.width, ref.height, ref.data);
  const candFrame = orthogonalFrameAngle(cand.width, cand.height, cand.data);
  const deskew = normalizeAngle(refFrame - candFrame);

  const hypRots = new Set<number>();
  for (const k of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    hypRots.add(normalizeAngle(deskew + k));
    hypRots.add(normalizeAngle(k)); // always consider pure page rotations
  }
  // Snap near-zero
  const rotations = [...hypRots].map((r) => (Math.abs(r) < 0.03 ? 0 : r));

  const refEdge = downEdgeMask(ref.width, ref.height, ref.data);
  const candEdge = downEdgeMask(cand.width, cand.height, cand.data);

  let best: SimilarityTransform | null = null;
  let bestScore = -1;
  for (const rotation of rotations) {
    const base = transformFromBBoxes(rb, cb, rc, cc, rotation);
    const baseScore = scoreEdgeAgreement(
      refEdge,
      candEdge,
      base,
      refEdge.sx,
      candEdge.sx,
    );
    if (baseScore > bestScore) {
      bestScore = baseScore;
      best = base;
    }

    // Only refine when the bbox estimate is clearly weak — searching
    // translation aggressively overfits dim/grid ink and breaks good cases.
    if (baseScore >= 0.22) continue;

    for (const scaleMul of [0.88, 0.94, 1.0, 1.06, 1.12]) {
      const scale = base.scale * scaleMul;
      for (const dx of [-40, -20, 0, 20, 40]) {
        for (const dy of [-40, -20, 0, 20, 40]) {
          const t: SimilarityTransform = {
            scale,
            rotation,
            tx: base.tx + dx,
            ty: base.ty + dy,
          };
          const score = scoreEdgeAgreement(
            refEdge,
            candEdge,
            t,
            refEdge.sx,
            candEdge.sx,
          );
          // Require a clear improvement over the bbox estimate for this rotation.
          if (score > bestScore && score > baseScore + 0.03) {
            bestScore = score;
            best = t;
          }
        }
      }
    }
  }

  return best ?? transformFromBBoxes(rb, cb, rc, cc, 0);
}

function spanLenPx(d: DimReading): number {
  return dist(d.span.a, d.span.b);
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1]! + s[m]!) / 2) : s[m]!;
}

/**
 * Refine a raster-estimated similarity transform using dimension readings that
 * share the same measured value. Scale comes from pixel span length ratios;
 * translation from midpoints after the new scale (rotation kept).
 *
 * Useful when candidate is a clean ABL render whose ink bbox does not match
 * the sketch's page framing — ink align under/over-scales the plan.
 */
export function refineTransformFromDims(
  reference: DimReading[],
  candidate: DimReading[],
  initial: SimilarityTransform,
  opts?: { dimTolInches?: number; minPairs?: number; minSpanPx?: number },
): { transform: SimilarityTransform; refined: boolean; pairCount: number; notes: string[] } {
  const dimTol = opts?.dimTolInches ?? 0.5;
  const minPairs = opts?.minPairs ?? 3;
  const minSpanPx = opts?.minSpanPx ?? 80;
  const notes: string[] = [];

  type Pair = { ref: DimReading; cand: DimReading; scale: number };
  const pairs: Pair[] = [];
  const usedCand = new Set<string>();

  // Prefer unique value matches: longer spans first (more stable scale).
  const refs = [...reference].sort((a, b) => spanLenPx(b) - spanLenPx(a));
  for (const ref of refs) {
    const refLen = spanLenPx(ref);
    if (refLen < minSpanPx) continue;
    let best: DimReading | null = null;
    let bestDv = Infinity;
    let bestCandLen = 0;
    for (const cand of candidate) {
      if (usedCand.has(cand.id)) continue;
      const dv = Math.abs(cand.valueInches - ref.valueInches);
      if (dv > dimTol) continue;
      const candLen = spanLenPx(cand);
      if (candLen < minSpanPx) continue;
      // Prefer exact value, then longer cand span.
      const score = dv * 1000 - candLen;
      const bestScore = bestDv * 1000 - bestCandLen;
      if (!best || score < bestScore) {
        best = cand;
        bestDv = dv;
        bestCandLen = candLen;
      }
    }
    if (!best) continue;
    usedCand.add(best.id);
    pairs.push({ ref, cand: best, scale: refLen / bestCandLen });
  }

  if (pairs.length < minPairs) {
    notes.push(
      `Align dim-refine skipped: only ${pairs.length} value-matched span(s) (need ${minPairs})`,
    );
    return { transform: initial, refined: false, pairCount: pairs.length, notes };
  }

  const scales = pairs.map((p) => p.scale);
  const newScale = median(scales);
  if (!(newScale > 0) || !Number.isFinite(newScale)) {
    notes.push("Align dim-refine skipped: invalid median scale");
    return { transform: initial, refined: false, pairCount: pairs.length, notes };
  }

  // Guard against pathological flips vs ink estimate.
  const ratio = newScale / Math.max(1e-9, initial.scale);
  if (ratio < 0.4 || ratio > 2.5) {
    notes.push(
      `Align dim-refine rejected: scale ${newScale.toFixed(4)} is ${ratio.toFixed(2)}× ink estimate ${initial.scale.toFixed(4)}`,
    );
    return { transform: initial, refined: false, pairCount: pairs.length, notes };
  }

  const rotation = initial.rotation;
  const c = Math.cos(rotation);
  const sn = Math.sin(rotation);

  // Keep the ink-align placement of the candidate plan center; only correct scale.
  // Dim midpoints are unreliable for translation (labels sit off walls / wrong mates).
  let cx = 0;
  let cy = 0;
  for (const p of pairs) {
    const m = mid(p.cand.span.a, p.cand.span.b);
    cx += m.x;
    cy += m.y;
  }
  cx /= pairs.length;
  cy /= pairs.length;
  const pivot = { x: cx, y: cy };
  const mapped = applyTransform(pivot, initial);
  const rx = c * (newScale * pivot.x) - sn * (newScale * pivot.y);
  const ry = sn * (newScale * pivot.x) + c * (newScale * pivot.y);
  const transform: SimilarityTransform = {
    scale: newScale,
    rotation,
    tx: mapped.x - rx,
    ty: mapped.y - ry,
  };

  notes.push(
    `Align dim-refine: ${pairs.length} value-matched span(s) → scale ${initial.scale.toFixed(4)} → ${newScale.toFixed(4)} (median; translation preserves ink pivot)`,
  );
  return { transform, refined: true, pairCount: pairs.length, notes };
}

/** Warp candidate into reference pixel grid. */
export async function warpCandidateToReference(
  candidatePng: Buffer,
  referencePng: Buffer,
  t: SimilarityTransform,
  background = { r: 245, g: 243, b: 236, alpha: 1 },
): Promise<Buffer> {
  const refSize = await imageSize(referencePng);
  const cand = await toRgba(candidatePng);
  const out = Buffer.alloc(refSize.width * refSize.height * 4);
  for (let i = 0; i < refSize.width * refSize.height; i++) {
    const o = i * 4;
    out[o] = background.r;
    out[o + 1] = background.g;
    out[o + 2] = background.b;
    out[o + 3] = Math.round(background.alpha * 255);
  }

  const inv = invertTransform(t);
  for (let y = 0; y < refSize.height; y++) {
    for (let x = 0; x < refSize.width; x++) {
      const src = applyTransform({ x, y }, inv);
      const sx = src.x;
      const sy = src.y;
      if (sx < 0 || sy < 0 || sx >= cand.width - 1 || sy >= cand.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (y * refSize.width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const i00 = (y0 * cand.width + x0) * 4 + ch;
        const i10 = (y0 * cand.width + x0 + 1) * 4 + ch;
        const i01 = ((y0 + 1) * cand.width + x0) * 4 + ch;
        const i11 = ((y0 + 1) * cand.width + x0 + 1) * 4 + ch;
        const v =
          (1 - fx) * (1 - fy) * (cand.data[i00] ?? 0) +
          fx * (1 - fy) * (cand.data[i10] ?? 0) +
          (1 - fx) * fy * (cand.data[i01] ?? 0) +
          fx * fy * (cand.data[i11] ?? 0);
        out[o + ch] = Math.round(v);
      }
    }
  }
  return sharp(out, {
    raw: { width: refSize.width, height: refSize.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** 50/50 onion skin of reference and aligned candidate. */
export async function onionSkin(
  referencePng: Buffer,
  alignedCandidatePng: Buffer,
): Promise<Buffer> {
  const [a, b] = await Promise.all([toRgba(referencePng), toRgba(alignedCandidatePng)]);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("onionSkin: size mismatch");
  }
  const out = Buffer.alloc(a.data.length);
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    out[o] = Math.round(0.55 * (a.data[o] ?? 0) + 0.45 * (b.data[o] ?? 0));
    out[o + 1] = Math.round(0.55 * (a.data[o + 1] ?? 0) + 0.45 * (b.data[o + 1] ?? 0));
    out[o + 2] = Math.round(0.55 * (a.data[o + 2] ?? 0) + 0.45 * (b.data[o + 2] ?? 0));
    out[o + 3] = 255;
  }
  return sharp(out, { raw: { width: a.width, height: a.height, channels: 4 } })
    .png()
    .toBuffer();
}
