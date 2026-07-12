import type { Point } from "../types";

/**
 * Infer the canvas the model used for absolute pixel coords.
 * Gemini sometimes echoes the prompted width/height but still returns ~0–1000 coords
 * (its usual bbox convention). Prefer declared/sent pixel space unless coords clearly
 * fit a 0–1000 normalized box with spread in both axes.
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

  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return { coordW: declaredW, coordH: declaredH };
  }

  // Any coord above 1000 ⇒ true pixel space on the sent/declared canvas.
  if (maxX > 1005 || maxY > 1005) {
    return coordCanvasFromDeclared(declaredW, declaredH, sentW, sentH);
  }

  // Model explicitly declared a sub-1000 canvas.
  if (declaredW <= 1005 || declaredH <= 1005) {
    return {
      coordW: declaredW,
      coordH: declaredH,
      note:
        declaredW !== sentW || declaredH !== sentH
          ? `Coords mapped from model canvas ${declaredW}×${declaredH} (sent ${sentW}×${sentH})`
          : undefined,
    };
  }

  // Gemini may echo full image size but return 0–1000-normalized points.
  // Require substantial spread in BOTH axes (relative to 1000, not declared canvas)
  // so sparse corner pixel clusters are not mistaken for normalized coords.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const longSent = Math.max(sentW, sentH);
  const spreadLooksNormalized =
    longSent > 1200 &&
    (declaredW > 1500 || declaredH > 1500) &&
    spanX >= 350 &&
    spanY >= 350;

  if (spreadLooksNormalized) {
    return {
      coordW: 1000,
      coordH: 1000,
      note: `Model coords look 0–1000-normalized (span ${spanX.toFixed(0)}×${spanY.toFixed(0)} on declared ${declaredW}×${declaredH}); mapping via 1000×1000`,
    };
  }

  return coordCanvasFromDeclared(declaredW, declaredH, sentW, sentH);
}

function coordCanvasFromDeclared(
  declaredW: number,
  declaredH: number,
  sentW: number,
  sentH: number,
): { coordW: number; coordH: number; note?: string } {
  if (declaredW !== sentW || declaredH !== sentH) {
    return {
      coordW: declaredW,
      coordH: declaredH,
      note: `Coords mapped from model canvas ${declaredW}×${declaredH} (sent ${sentW}×${sentH})`,
    };
  }
  return { coordW: declaredW, coordH: declaredH };
}
