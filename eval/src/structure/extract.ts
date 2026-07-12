import { createVisionClient, parseJsonBlock, type VisionClient } from "../vision/client";
import { prepareVisionImage } from "../vision/prepare";
import { scalePointFromResized } from "../vision/resize";
import type {
  Junction,
  JunctionKind,
  Point,
  StructureReading,
  WallSpan,
} from "../types";

const SYSTEM = `You are an expert architectural draftsperson reading floor-plan STRUCTURE only.

Your job is to recover the WALL GEOMETRY of the plan:
- Junctions: corners, T-joins, wall ends, crossings where wall centerlines / faces meet.
- Wall spans: straight wall segments between junctions (the building fabric).

Critical rules:
- IGNORE dimension annotations entirely: dim lines, extension lines, ticks, arrows, and
  written dimension numbers. Do not treat dim-line endpoints as junctions.
- IGNORE room labels, notes, stairs hatching, furniture, and title blocks.
- Prefer interior/exterior WALL strokes and their corners.
- Return absolute pixel coordinates (origin top-left) in the image size given.
- Wall span endpoints should land on junctions (or wall faces) of the STRUCTURE, not on
  floating dimension graphics.`;

interface RawJunction {
  id?: string;
  x: number;
  y: number;
  kind?: string;
  confidence?: number;
}

interface RawWallSpan {
  id?: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  aJunctionId?: string;
  bJunctionId?: string;
  confidence?: number;
}

interface StructurePayload {
  width: number;
  height: number;
  junctions: RawJunction[];
  wallSpans: RawWallSpan[];
}

function clampPoint(p: Point, w: number, h: number): Point {
  return {
    x: Math.max(0, Math.min(w - 1, p.x)),
    y: Math.max(0, Math.min(h - 1, p.y)),
  };
}

function parseKind(k?: string): JunctionKind {
  const s = (k ?? "").toLowerCase();
  if (s === "corner" || s === "t" || s === "cross" || s === "end") return s;
  return "unknown";
}

function toOrig(
  p: Point,
  origW: number,
  origH: number,
  visionW: number,
  visionH: number,
): Point {
  return clampPoint(scalePointFromResized(p, origW, origH, visionW, visionH), origW, origH);
}

/**
 * One-shot structure extract: junctions + wall spans.
 * Pre-resizes per Claude vision docs; coords stored in original image space.
 */
export async function extractStructure(
  png: Buffer,
  opts?: { client?: VisionClient | null },
): Promise<{ structure: StructureReading; notes: string[] }> {
  const notes: string[] = [];
  const client = opts?.client === undefined ? createVisionClient() : opts.client;
  if (!client) {
    notes.push("No vision client — skipped structure extract");
    return { structure: { junctions: [], wallSpans: [] }, notes };
  }
  notes.push(`Structure vision: ${client.provider} / ${client.model}`);

  try {
    const prepared = await prepareVisionImage(png, client.model);
    const { send, mediaType, origW, origH, visionW, visionH, didResize } = prepared;
    if (didResize) {
      notes.push(
        `Structure pre-resized ${origW}×${origH} → ${visionW}×${visionH}; coords scaled back to original`,
      );
    }

    const prompt = `Image size: ${visionW} x ${visionH} pixels.

Extract the WALL STRUCTURE of this floor plan (junctions + wall spans).
Ignore all dimension annotations and text.

Return absolute pixel coordinates in this ${visionW}×${visionH} image.
Return JSON only:
{
  "width": ${visionW},
  "height": ${visionH},
  "junctions": [
    { "id": "j1", "x": 0, "y": 0, "kind": "corner", "confidence": 0.9 }
  ],
  "wallSpans": [
    {
      "id": "w1",
      "a": { "x": 0, "y": 0 },
      "b": { "x": 1, "y": 0 },
      "aJunctionId": "j1",
      "bJunctionId": "j2",
      "confidence": 0.9
    }
  ]
}

kind is one of: corner, t, cross, end, unknown.
Prefer complete exterior + major interior walls. Skip tiny ticks and dim graphics.`;

    const text = await client.complete({
      system: SYSTEM,
      prompt,
      images: [{ data: send, mediaType }],
      json: true,
    });
    const payload = parseJsonBlock<StructurePayload>(text);
    const junctions: Junction[] = (payload.junctions ?? []).map((j, i) => ({
      id: j.id ?? `j-${i + 1}`,
      point: toOrig({ x: j.x, y: j.y }, origW, origH, visionW, visionH),
      kind: parseKind(j.kind),
      confidence: j.confidence,
      verified: false,
    }));
    const wallSpans: WallSpan[] = (payload.wallSpans ?? [])
      .filter((w) => w?.a && w?.b)
      .map((w, i) => ({
        id: w.id ?? `w-${i + 1}`,
        a: toOrig(w.a, origW, origH, visionW, visionH),
        b: toOrig(w.b, origW, origH, visionW, visionH),
        aJunctionId: w.aJunctionId,
        bJunctionId: w.bJunctionId,
        confidence: w.confidence,
        verified: false,
      }));

    notes.push(
      `Structure found ${junctions.length} junction(s), ${wallSpans.length} wall span(s)`,
    );
    return { structure: { junctions, wallSpans }, notes };
  } catch (e) {
    notes.push(`Structure extract failed: ${(e as Error).message}`);
    return { structure: { junctions: [], wallSpans: [] }, notes };
  }
}
