import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { estimateSimilarityTransform, orthogonalFrameAngle } from "../align";
import { toRgba } from "../image";

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
