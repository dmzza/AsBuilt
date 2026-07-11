import sharp from "sharp";
import { edgeMap, toRgba } from "./image";
import type { BBox, Finding } from "./types";

export interface LayoutCompareResult {
  score: number;
  findings: Finding[];
  diffPng: Buffer;
}

/**
 * Compare edge maps of reference vs aligned candidate in reference pixel space.
 * Emits regional findings where mismatch is concentrated.
 */
export async function compareLayout(
  referencePng: Buffer,
  alignedCandidatePng: Buffer,
  mismatchThreshold = 0.35,
): Promise<LayoutCompareResult> {
  const [ref, cand] = await Promise.all([toRgba(referencePng), toRgba(alignedCandidatePng)]);
  const re = edgeMap(ref.width, ref.height, ref.data);
  const ce = edgeMap(cand.width, cand.height, cand.data);
  const edgeThresh = 35;
  let agree = 0;
  let refOnly = 0;
  let candOnly = 0;
  const diff = Buffer.alloc(ref.width * ref.height * 4);

  for (let i = 0; i < ref.width * ref.height; i++) {
    const rv = (re[i] ?? 0) >= edgeThresh;
    const cv = (ce[i] ?? 0) >= edgeThresh;
    const o = i * 4;
    if (rv && cv) {
      agree++;
      diff[o] = 40;
      diff[o + 1] = 160;
      diff[o + 2] = 80;
      diff[o + 3] = 255;
    } else if (rv && !cv) {
      refOnly++;
      diff[o] = 200;
      diff[o + 1] = 60;
      diff[o + 2] = 40;
      diff[o + 3] = 255;
    } else if (!rv && cv) {
      candOnly++;
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

  const total = agree + refOnly + candOnly;
  const score = total === 0 ? 0 : agree / total;
  const findings: Finding[] = [];

  // Tile the image and emit findings for hotspots
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
          const rv = (re[i] ?? 0) >= edgeThresh;
          const cv = (ce[i] ?? 0) >= edgeThresh;
          if (rv && cv) both++;
          else if (rv) rOnly++;
          else if (cv) cOnly++;
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

  // Cap findings for reviewability
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
