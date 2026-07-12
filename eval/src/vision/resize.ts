/**
 * Anthropic vision resize helpers — ported from
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
 *
 * Claude returns pixel coords in the image *it sees* after resize+pad.
 * Pre-resize to this size before upload so coords are predictable, then
 * map back to the original image (never divide by padded dims).
 */

export type VisionResolutionTier = "standard" | "high" | "gemini";

export interface VisionResizeLimits {
  maxEdge: number;
  maxTokens: number;
}

/** Standard: 1568 edge / 1568 tokens. High-res: 2576 / 4784 (Sonnet 5, Opus 4.7+, Fable). */
export function limitsForTier(tier: VisionResolutionTier): VisionResizeLimits {
  if (tier === "gemini") return { maxEdge: 4096, maxTokens: 12000 };
  if (tier === "high") return { maxEdge: 2576, maxTokens: 4784 };
  return { maxEdge: 1568, maxTokens: 1568 };
}

/** Infer tier from model id (Anthropic Claude resize rules, or Gemini generous cap). */
export function tierForModel(model: string): VisionResolutionTier {
  const m = model.toLowerCase();
  if (m.includes("gemini")) return "gemini";
  if (
    m.includes("sonnet-5") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-8") ||
    m.includes("fable") ||
    m.includes("mythos")
  ) {
    return "high";
  }
  return "standard";
}

/** Visual tokens: one token per 28×28 patch. */
export function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/**
 * Round half to even (banker's rounding), matching Python's round() / the API.
 * Math.round alone would diverge for some .5 ties.
 */
export function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude resizes an image to *before* padding.
 * Images that already fit are returned unchanged.
 */
export function resizedSize(
  width: number,
  height: number,
  maxEdge = 1568,
  maxTokens = 1568,
): [number, number] {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / 28) * 28 <= maxEdge &&
    Math.ceil(h / 28) * 28 <= maxEdge &&
    countImageTokens(w, h) <= maxTokens;

  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [resizedH, resizedW] = resizedSize(height, width, maxEdge, maxTokens);
    return [resizedW, resizedH];
  }

  const aspectRatio = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)];
}

export function resizedSizeForModel(
  width: number,
  height: number,
  model: string,
): [number, number] {
  const { maxEdge, maxTokens } = limitsForTier(tierForModel(model));
  return resizedSize(width, height, maxEdge, maxTokens);
}

/** Map a point from Claude-seen (resized) space → original image space. */
export function scalePointFromResized(
  p: { x: number; y: number },
  originalW: number,
  originalH: number,
  resizedW: number,
  resizedH: number,
): { x: number; y: number } {
  return {
    x: (p.x * originalW) / resizedW,
    y: (p.y * originalH) / resizedH,
  };
}
