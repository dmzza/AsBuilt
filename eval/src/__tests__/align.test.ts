import { describe, expect, test } from "vitest";
import sharp from "sharp";
import {
  estimateSimilarityTransform,
  orthogonalFrameAngle,
  refineTransformFromDims,
} from "../align";
import { toRgba } from "../image";
import type { DimReading } from "../types";

async function hvPlanPng(w: number, h: number, skewDeg = 0): Promise<Buffer> {
  // Draw a simple axis-aligned rectangle room in SVG, optionally rotate.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f5f3ec"/>
    <g transform="rotate(${skewDeg} ${w / 2} ${h / 2})">
      <rect x="${w * 0.2}" y="${h * 0.25}" width="${w * 0.55}" height="${h * 0.45}"
        fill="none" stroke="#111" stroke-width="6"/>
      <line x1="${w * 0.2}" y1="${h * 0.5}" x2="${w * 0.75}" y2="${h * 0.5}"
        stroke="#111" stroke-width="4"/>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("orthogonalFrameAngle", () => {
  test("axis-aligned plan ≈ 0", async () => {
    const png = await hvPlanPng(400, 300, 0);
    const { width, height, data } = await toRgba(png);
    expect(Math.abs(orthogonalFrameAngle(width, height, data))).toBeLessThan(0.05);
  });

  test("skewed plan recovers skew", async () => {
    const png = await hvPlanPng(400, 300, 12);
    const { width, height, data } = await toRgba(png);
    const a = (orthogonalFrameAngle(width, height, data) * 180) / Math.PI;
    expect(a).toBeGreaterThan(8);
    expect(a).toBeLessThan(16);
  });
});

describe("estimateSimilarityTransform", () => {
  test("does not invent large rotation for axis-aligned pair", async () => {
    const ref = await hvPlanPng(500, 400, 0);
    const cand = await hvPlanPng(250, 200, 0);
    const t = await estimateSimilarityTransform(ref, cand);
    expect(Math.abs((t.rotation * 180) / Math.PI)).toBeLessThan(3);
    expect(t.scale).toBeGreaterThan(1.5);
    expect(t.scale).toBeLessThan(2.5);
  });
});

function dim(
  id: string,
  inches: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): DimReading {
  return {
    id,
    valueInches: inches,
    valueText: `${inches}"`,
    labelBBox: { x: ax, y: ay, w: 40, h: 16 },
    span: { a: { x: ax, y: ay }, b: { x: bx, y: by } },
    verified: true,
    confidence: 1,
  };
}

describe("refineTransformFromDims", () => {
  test("recovers true scale and translation from value-matched spans", () => {
    // Cand is 2× in pixels + offset. True map: scale=0.5, tx=75, ty=75.
    const reference = [
      dim("r1", 120, 100, 100, 340, 100), // 240px
      dim("r2", 96, 100, 100, 100, 292), // 192px
      dim("r3", 144, 100, 115, 388, 115), // 288px
    ];
    const candidate = [
      dim("c1", 120, 50, 50, 530, 50), // 480px
      dim("c2", 96, 50, 50, 50, 434), // 384px
      dim("c3", 144, 50, 80, 626, 80), // 576px
    ];
    // Wrong ink guess: bad scale and translation.
    const inkGuess = { scale: 0.9, rotation: 0, tx: -40, ty: 200 };
    const { transform, refined, pairCount } = refineTransformFromDims(
      reference,
      candidate,
      inkGuess,
    );
    expect(refined).toBe(true);
    expect(pairCount).toBe(3);
    expect(transform.scale).toBeCloseTo(0.5, 3);
    expect(transform.tx).toBeCloseTo(75, 0);
    expect(transform.ty).toBeCloseTo(75, 0);
  });

  test("skips when too few matches", () => {
    const reference = [dim("r1", 120, 0, 0, 200, 0)];
    const candidate = [dim("c1", 120, 0, 0, 400, 0)];
    const { refined, notes } = refineTransformFromDims(reference, candidate, {
      scale: 1,
      rotation: 0,
      tx: 0,
      ty: 0,
    });
    expect(refined).toBe(false);
    expect(notes.some((n) => /skipped/i.test(n))).toBe(true);
  });
});
