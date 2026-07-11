import sharp from "sharp";
import {
  edgeMap,
  imageSize,
  inkBBox,
  inkCentroid,
  inkMask,
  toRgba,
} from "./image";
import type { Point, SimilarityTransform } from "./types";

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

/**
 * Align candidate ink bbox/centroid to reference via uniform scale + translation
 * (rotation estimated from principal axis of edges when possible).
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

  const scaleX = rb.w / Math.max(1, cb.w);
  const scaleY = rb.h / Math.max(1, cb.h);
  const scale = (scaleX + scaleY) / 2;

  const refAngle = principalEdgeAngle(ref.width, ref.height, ref.data);
  const candAngle = principalEdgeAngle(cand.width, cand.height, cand.data);
  let rotation = refAngle - candAngle;
  // Snap near-orthogonal noise to 0
  if (Math.abs(rotation) < 0.08) rotation = 0;
  if (Math.abs(Math.abs(rotation) - Math.PI / 2) < 0.08) {
    rotation = rotation > 0 ? Math.PI / 2 : -Math.PI / 2;
  }

  // Map candidate centroid → reference centroid after scale+rotation about origin,
  // then solve translation.
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

function principalEdgeAngle(width: number, height: number, rgba: Buffer): number {
  const edges = edgeMap(width, height, rgba);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const thresh = 40;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const m = edges[y * width + x] ?? 0;
      if (m < thresh) continue;
      // local gradient direction approx via neighbors already in edgeMap magnitude;
      // use position relative to centroid for PCA on strong edge pixels
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }
  // Actually PCA on coordinates of edge pixels:
  let sx = 0;
  let sy = 0;
  let n = 0;
  const pts: Point[] = [];
  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      if ((edges[y * width + x] ?? 0) < thresh) continue;
      pts.push({ x, y });
      sx += x;
      sy += y;
      n++;
    }
  }
  if (n < 20) return 0;
  const mx = sx / n;
  const my = sy / n;
  sxx = 0;
  syy = 0;
  sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
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
      for (let c = 0; c < 4; c++) {
        const i00 = (y0 * cand.width + x0) * 4 + c;
        const i10 = (y0 * cand.width + x0 + 1) * 4 + c;
        const i01 = ((y0 + 1) * cand.width + x0) * 4 + c;
        const i11 = ((y0 + 1) * cand.width + x0 + 1) * 4 + c;
        const v =
          (1 - fx) * (1 - fy) * (cand.data[i00] ?? 0) +
          fx * (1 - fy) * (cand.data[i10] ?? 0) +
          (1 - fx) * fy * (cand.data[i01] ?? 0) +
          fx * fy * (cand.data[i11] ?? 0);
        out[o + c] = Math.round(v);
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
