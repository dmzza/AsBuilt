import sharp from "sharp";
import { edgeMap, toRgba } from "./image";
import type { BBox, Finding } from "./types";

export interface LayoutCompareResult {
  score: number;
  findings: Finding[];
  diffPng: Buffer;
}

/** Dilate a binary mask; used so nearby walls still count as agreement. */
function dilateMask(
  width: number,
  height: number,
  mask: Uint8Array,
  radius: number,
): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(width * height);
  const r2 = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Compare edge maps of two images in the same pixel space (usually reference).
 * Prefer walls-only structure layers from the caller — Original PNGs mix in
 * grids, labels, and other non-layout ink.
 * Soft F1: an edge counts as a hit if the other image has an edge within radius.
 */
export async function compareLayout(
  referencePng: Buffer,
  alignedCandidatePng: Buffer,
  mismatchThreshold = 0.35,
): Promise<LayoutCompareResult> {
  const [ref, cand] = await Promise.all([toRgba(referencePng), toRgba(alignedCandidatePng)]);
  const re = edgeMap(ref.width, ref.height, ref.data);
  const ce = edgeMap(cand.width, cand.height, cand.data);
  const edgeThresh = 40;
  const radius = Math.max(2, Math.min(4, Math.round(Math.min(ref.width, ref.height) / 800)));

  const refMask = new Uint8Array(ref.width * ref.height);
  const candMask = new Uint8Array(ref.width * ref.height);
  for (let i = 0; i < ref.width * ref.height; i++) {
    if ((re[i] ?? 0) >= edgeThresh) refMask[i] = 1;
    if ((ce[i] ?? 0) >= edgeThresh) candMask[i] = 1;
  }
  const refDilated = dilateMask(ref.width, ref.height, refMask, radius);
  const candDilated = dilateMask(ref.width, ref.height, candMask, radius);

  let refHits = 0;
  let refEdges = 0;
  let candHits = 0;
  let candEdges = 0;
  const diff = Buffer.alloc(ref.width * ref.height * 4);

  for (let i = 0; i < ref.width * ref.height; i++) {
    const o = i * 4;
    const rv = refMask[i] === 1;
    const cv = candMask[i] === 1;
    const rHit = rv && candDilated[i] === 1;
    const cHit = cv && refDilated[i] === 1;
    if (rv) {
      refEdges++;
      if (rHit) refHits++;
    }
    if (cv) {
      candEdges++;
      if (cHit) candHits++;
    }

    if (rHit || cHit) {
      diff[o] = 40;
      diff[o + 1] = 160;
      diff[o + 2] = 80;
      diff[o + 3] = 255;
    } else if (rv) {
      diff[o] = 200;
      diff[o + 1] = 60;
      diff[o + 2] = 40;
      diff[o + 3] = 255;
    } else if (cv) {
      diff[o] = 40;
      diff[o + 1] = 90;
      diff[o + 2] = 220;
      diff[o + 3] = 255;
    } else {
      const g = ref.data[o] ?? 245;
      diff[o] = g;
      diff[o + 1] = ref.data[o + 1] ?? 243;
      diff[o + 2] = ref.data[o + 2] ?? 236;
      diff[o + 3] = 255;
    }
  }

  const recall = refEdges === 0 ? 0 : refHits / refEdges;
  const precision = candEdges === 0 ? 0 : candHits / candEdges;
  const score =
    recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);

  const findings: Finding[] = [];
  const tile = 128;
  let findingIdx = 0;
  for (let ty = 0; ty < ref.height; ty += tile) {
    for (let tx = 0; tx < ref.width; tx += tile) {
      let rOnly = 0;
      let cOnly = 0;
      let both = 0;
      const tw = Math.min(tile, ref.width - tx);
      const th = Math.min(tile, ref.height - ty);
      for (let y = ty; y < ty + th; y++) {
        for (let x = tx; x < tx + tw; x++) {
          const i = y * ref.width + x;
          const rv = refMask[i] === 1;
          const cv = candMask[i] === 1;
          if (!rv && !cv) continue;
          const rHit = rv && candDilated[i] === 1;
          const cHit = cv && refDilated[i] === 1;
          if (rHit || cHit) both++;
          else if (rv) rOnly++;
          else cOnly++;
        }
      }
      const tTotal = both + rOnly + cOnly;
      if (tTotal < 40) continue;
      const miss = (rOnly + cOnly) / tTotal;
      if (miss < mismatchThreshold) continue;
      const bbox: BBox = { x: tx, y: ty, w: tw, h: th };
      if (rOnly > cOnly * 1.3) {
        findings.push({
          id: `layout-missing-${findingIdx++}`,
          kind: "layout_missing",
          message: `Structure in reference missing from candidate (tile mismatch ${(miss * 100).toFixed(0)}%)`,
          severity: "warn",
          referenceBBox: bbox,
          alignedBBox: bbox,
          status: "provisional",
        });
      } else if (cOnly > rOnly * 1.3) {
        findings.push({
          id: `layout-extra-${findingIdx++}`,
          kind: "layout_extra",
          message: `Extra structure in candidate vs reference (tile mismatch ${(miss * 100).toFixed(0)}%)`,
          severity: "warn",
          referenceBBox: bbox,
          alignedBBox: bbox,
          status: "provisional",
        });
      } else {
        findings.push({
          id: `layout-divergent-${findingIdx++}`,
          kind: "topology",
          message: `Layout divergence in region (mismatch ${(miss * 100).toFixed(0)}%)`,
          severity: "warn",
          referenceBBox: bbox,
          alignedBBox: bbox,
          status: "provisional",
        });
      }
    }
  }

  findings.sort((a, b) => {
    const area = (f: Finding) => (f.referenceBBox?.w ?? 0) * (f.referenceBBox?.h ?? 0);
    return area(b) - area(a);
  });
  const capped = findings.slice(0, 24);

  const diffPng = await sharp(diff, {
    raw: { width: ref.width, height: ref.height, channels: 4 },
  })
    .png()
    .toBuffer();

  return { score, findings: capped, diffPng };
}
