import type { Point } from "../types";

/**
 * Infer the canvas the model used for absolute pixel coords.
 * Gemini often echoes the prompted width/height but still returns ~0–1000 coords
 * (its usual bbox convention). Prefer the model's declared size when it matches
 * the coordinate ranges; otherwise fall back to a 1000×1000 normalized space.
 */
export function resolveModelCoordCanvas(opts: {
  sentW: number;
  sentH: number;
  payloadW?: number;
  payloadH?: number;
  points: Point[];
}): { coordW: number; coordH: number; note?: string } {
  const { sentW, sentH, points } = opts;
  const declaredW =
    Number.isFinite(opts.payloadW) && (opts.payloadW as number) > 0
      ? (opts.payloadW as number)
      : sentW;
  const declaredH =
    Number.isFinite(opts.payloadH) && (opts.payloadH as number) > 0
      ? (opts.payloadH as number)
      : sentH;

  if (points.length === 0) {
    return { coordW: declaredW, coordH: declaredH };
  }

  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    if (Number.isFinite(p.x)) maxX = Math.max(maxX, p.x);
    if (Number.isFinite(p.y)) maxY = Math.max(maxY, p.y);
  }

  const longSent = Math.max(sentW, sentH);
  const looksNormalized =
    maxX <= 1005 &&
    maxY <= 1005 &&
    longSent > 1200 &&
    // Declared canvas is much larger than observed coords → not pixel-aligned.
    (declaredW > 1500 || declaredH > 1500) &&
    maxX < declaredW * 0.4 &&
    maxY < declaredH * 0.4;

  if (looksNormalized) {
    return {
      coordW: 1000,
      coordH: 1000,
      note: `Model coords look 0–1000-normalized (max ${maxX.toFixed(0)},${maxY.toFixed(0)} on declared ${declaredW}×${declaredH}); mapping via 1000×1000`,
    };
  }

  if (declaredW !== sentW || declaredH !== sentH) {
    return {
      coordW: declaredW,
      coordH: declaredH,
      note: `Coords mapped from model canvas ${declaredW}×${declaredH} (sent ${sentW}×${sentH})`,
    };
  }

  return { coordW: declaredW, coordH: declaredH };
}
