import { createVisionClient, parseJsonBlock, type VisionClient } from "../vision/client";
import { resolveModelCoordCanvas } from "../vision/coords";
import { prepareVisionImage } from "../vision/prepare";
import { scalePointFromResized } from "../vision/resize";
import type {
  Junction,
  JunctionKind,
  Point,
  StructureReading,
  WallSpan,
} from "../types";
import {
  redrawStructureClean,
  type ImageCleanStatus,
} from "./redraw";

const SYSTEM = `You are an expert architectural draftsperson reading floor-plan STRUCTURE only.

Your job is to recover the WALL GEOMETRY of the plan:
- Junctions: corners, T-joins, wall ends, crossings where wall centerlines / faces meet.
- Wall spans: straight wall segments between junctions (the building fabric).

Critical rules:
- This image should already be a clean wall/window/door drawing. Prefer the inked
  wall strokes; ignore any residual annotation if present.
- Prefer interior/exterior WALL strokes and their corners.
- Return absolute pixel coordinates (origin top-left) in the image size given.
- Wall span endpoints should land on junctions (or wall faces) of the STRUCTURE.`;

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

async function extractStructureFromPng(
  png: Buffer,
  client: VisionClient,
): Promise<{ structure: StructureReading; notes: string[] }> {
  const notes: string[] = [];
  const prepared = await prepareVisionImage(png, client.model);
  const { send, mediaType, origW, origH, visionW, visionH, didResize } = prepared;
  if (didResize) {
    notes.push(
      `Structure pre-resized ${origW}×${origH} → ${visionW}×${visionH}; coords scaled back to original`,
    );
  }

  const prompt = `Image size: ${visionW} x ${visionH} pixels.

Extract the WALL STRUCTURE of this floor plan (junctions + wall spans).
This should be a clean walls/windows/doors drawing — ignore any leftover annotations.

Return absolute pixel coordinates in this ${visionW}×${visionH} image.
Do NOT use normalized 0–1000 boxes — x/y must be in pixels with the same width/height you echo below.
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
  let payload: StructurePayload;
  try {
    payload = parseJsonBlock<StructurePayload>(text);
  } catch (e) {
    notes.push(`Structure JSON parse failed once (${(e as Error).message.slice(0, 80)}); retrying`);
    const retry = await client.complete({
      system: SYSTEM,
      prompt: `${prompt}\n\nPrevious response was invalid JSON. Reply with a single valid JSON object only.`,
      images: [{ data: send, mediaType }],
      json: true,
    });
    payload = parseJsonBlock<StructurePayload>(retry);
  }
  const samplePoints: Point[] = [];
  for (const j of payload.junctions ?? []) {
    if (j) samplePoints.push({ x: j.x, y: j.y });
  }
  for (const w of payload.wallSpans ?? []) {
    if (w?.a) samplePoints.push(w.a);
    if (w?.b) samplePoints.push(w.b);
  }
  const canvas = resolveModelCoordCanvas({
    sentW: visionW,
    sentH: visionH,
    payloadW: payload.width,
    payloadH: payload.height,
    points: samplePoints,
  });
  if (canvas.note) notes.push(canvas.note);
  const { coordW, coordH } = canvas;
  const junctions: Junction[] = (payload.junctions ?? []).map((j, i) => ({
    id: j.id ?? `j-${i + 1}`,
    point: toOrig({ x: j.x, y: j.y }, origW, origH, coordW, coordH),
    kind: parseKind(j.kind),
    confidence: j.confidence,
    verified: false,
  }));
  const wallSpans: WallSpan[] = (payload.wallSpans ?? [])
    .filter((w) => w?.a && w?.b)
    .map((w, i) => ({
      id: w.id ?? `w-${i + 1}`,
      a: toOrig(w.a, origW, origH, coordW, coordH),
      b: toOrig(w.b, origW, origH, coordW, coordH),
      aJunctionId: w.aJunctionId,
      bJunctionId: w.bJunctionId,
      confidence: w.confidence,
      verified: false,
    }));

  notes.push(
    `Structure found ${junctions.length} junction(s), ${wallSpans.length} wall span(s)`,
  );
  return { structure: { junctions, wallSpans }, notes };
}

export interface ExtractStructureResult {
  structure: StructureReading;
  /** Cleaned walls-only PNG at original size when redraw succeeded. */
  cleanedPng: Buffer | null;
  cleanedStatus: ImageCleanStatus;
  notes: string[];
}

/**
 * Structure extract with a Nano Banana clean-redraw pass first.
 * 1) Gemini image model redraws walls/windows/doors only → PNG artifact
 * 2) Junctions + wall spans read from that cleaned image (fallback: original)
 * Dim extract uses its own dims-only redraw (caller responsibility).
 * Coords stored in original image space.
 */
export async function extractStructure(
  png: Buffer,
  opts?: {
    client?: VisionClient | null;
    skipClean?: boolean;
    /** Durable cache path for cleaned structure PNG (caseDir/cleaned/structure_*.png). */
    cleanedCachePath?: string;
  },
): Promise<ExtractStructureResult> {
  const notes: string[] = [];
  const client = opts?.client === undefined ? createVisionClient() : opts.client;
  if (!client) {
    notes.push("No vision client — skipped structure extract");
    return {
      structure: { junctions: [], wallSpans: [] },
      cleanedPng: null,
      cleanedStatus: "skipped",
      notes,
    };
  }
  notes.push(`Structure vision: ${client.provider} / ${client.model}`);

  let cleanedPng: Buffer | null = null;
  let cleanedStatus: ImageCleanStatus = "skipped";
  let source = png;

  if (!opts?.skipClean) {
    const redraw = await redrawStructureClean(png, {
      cachePath: opts?.cleanedCachePath,
    });
    notes.push(...redraw.notes);
    cleanedStatus = redraw.status;
    if (redraw.cleanedPng) {
      cleanedPng = redraw.cleanedPng;
      source = redraw.cleanedPng;
      notes.push(
        redraw.status === "cached"
          ? "Structure extract running on cached cleaned image"
          : "Structure extract running on cleaned redraw",
      );
    } else if (redraw.status === "fallback") {
      notes.push("Structure extract falling back to original image");
    }
  }

  try {
    const extracted = await extractStructureFromPng(source, client);
    notes.push(...extracted.notes);
    return {
      structure: extracted.structure,
      cleanedPng,
      cleanedStatus,
      notes,
    };
  } catch (e) {
    notes.push(`Structure extract failed: ${(e as Error).message}`);
    return {
      structure: { junctions: [], wallSpans: [] },
      cleanedPng,
      cleanedStatus,
      notes,
    };
  }
}
