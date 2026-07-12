import sharp from "sharp";
import { parseDimText } from "../image";
import {
  redrawDimsClean,
  type ImageCleanStatus,
} from "../structure/redraw";
import { createVisionClient, parseJsonBlock, type VisionClient } from "../vision/client";
import { imageMeta, prepareVisionImage } from "../vision/prepare";
import { scalePointFromResized } from "../vision/resize";
import type { BBox, DimReading, DimSpan, Point } from "../types";

const SYSTEM = `You are an expert architectural draftsperson reviewing floor-plan images
(hand drawings or CAD). Your job is to find every written dimension and the
span it measures.

Critical rules:
- Separate WALL strokes from DIMENSION graphics (dim lines, extension lines, ticks, arrows).
- This image may already be a clean dimensions-only drawing. Prefer dimension
  ink (values, dim lines, extension lines, ticks); ignore any residual walls.
- For each dimension, return the numeric value AND the two endpoints of the measured span
  in absolute pixel coordinates (origin top-left, x right, y down) of THIS image as given
  (width × height stated in the user message). Do not normalize coordinates.
- Endpoints should land on the wall corners / faces being measured, NOT merely on the
  dimension string. Prefer extension-line intersections with the measured wall
  (or the implied measured edge from extension lines when walls were removed).
- If wall-vs-dim-line is ambiguous, include alternateSpans with competing endpoint pairs.
- Ignore room labels and notes that are not dimensions.
- Coordinates must be within the image bounds you are given.`;

interface RawDim {
  id?: string;
  valueText: string;
  valueInches?: number;
  labelBBox: { x: number; y: number; w: number; h: number };
  span: { a: { x: number; y: number }; b: { x: number; y: number } };
  dimGraphics?: {
    dimLine?: { a: Point; b: Point };
    extensionA?: { a: Point; b: Point };
    extensionB?: { a: Point; b: Point };
  };
  confidence?: number;
  alternateSpans?: { a: Point; b: Point }[];
  notes?: string;
}

interface ExtractPayload {
  width: number;
  height: number;
  dimensions: RawDim[];
}

function clampPoint(p: Point, w: number, h: number): Point {
  return {
    x: Math.max(0, Math.min(w - 1, p.x)),
    y: Math.max(0, Math.min(h - 1, p.y)),
  };
}

function clampBBox(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(w - 1, b.x));
  const y = Math.max(0, Math.min(h - 1, b.y));
  const w2 = Math.max(1, Math.min(w - x, b.w));
  const h2 = Math.max(1, Math.min(h - y, b.h));
  return { x, y, w: w2, h: h2 };
}

function scaleSeg(
  s: { a: Point; b: Point },
  origW: number,
  origH: number,
  rw: number,
  rh: number,
): { a: Point; b: Point } {
  return {
    a: scalePointFromResized(s.a, origW, origH, rw, rh),
    b: scalePointFromResized(s.b, origW, origH, rw, rh),
  };
}

function normalizeReading(
  raw: RawDim,
  idx: number,
  /** Space the model returned coords in (resized / sent image). */
  visionW: number,
  visionH: number,
  /** Original image to map coords into. */
  origW: number,
  origH: number,
): DimReading | null {
  const inches =
    raw.valueInches ??
    parseDimText(raw.valueText) ??
    (typeof raw.valueInches === "number" ? raw.valueInches : null);
  if (inches === null || !Number.isFinite(inches)) return null;
  if (!raw.span?.a || !raw.span?.b || !raw.labelBBox) return null;

  const toOrig = (p: Point) =>
    clampPoint(scalePointFromResized(p, origW, origH, visionW, visionH), origW, origH);

  const span: DimSpan = { a: toOrig(raw.span.a), b: toOrig(raw.span.b) };
  const labelTL = toOrig({ x: raw.labelBBox.x, y: raw.labelBBox.y });
  const labelBR = toOrig({
    x: raw.labelBBox.x + raw.labelBBox.w,
    y: raw.labelBBox.y + raw.labelBBox.h,
  });
  const labelBBox = clampBBox(
    {
      x: labelTL.x,
      y: labelTL.y,
      w: Math.max(1, labelBR.x - labelTL.x),
      h: Math.max(1, labelBR.y - labelTL.y),
    },
    origW,
    origH,
  );

  const alt =
    raw.alternateSpans
      ?.map((s) => ({ a: toOrig(s.a), b: toOrig(s.b) }))
      .filter((s) => Number.isFinite(s.a.x) && Number.isFinite(s.b.x)) ?? undefined;

  let dimGraphics = raw.dimGraphics;
  if (dimGraphics) {
    dimGraphics = {
      dimLine: dimGraphics.dimLine
        ? scaleSeg(dimGraphics.dimLine, origW, origH, visionW, visionH)
        : undefined,
      extensionA: dimGraphics.extensionA
        ? scaleSeg(dimGraphics.extensionA, origW, origH, visionW, visionH)
        : undefined,
      extensionB: dimGraphics.extensionB
        ? scaleSeg(dimGraphics.extensionB, origW, origH, visionW, visionH)
        : undefined,
    };
  }

  return {
    id: raw.id ?? `dim-${idx}`,
    valueInches: inches,
    valueText: raw.valueText,
    labelBBox,
    span,
    dimGraphics,
    confidence: raw.confidence,
    alternateSpans: alt && alt.length > 0 ? alt : undefined,
    verified: false,
  };
}

async function extractPass(
  client: VisionClient,
  png: Buffer,
  passLabel: string,
): Promise<{ readings: DimReading[]; resizeNote?: string }> {
  const prepared = await prepareVisionImage(png, client.model);
  const { send, mediaType, origW, origH, visionW, visionH, didResize } = prepared;

  const prompt = `Pass: ${passLabel}
Image size: ${visionW} x ${visionH} pixels.

Find ALL written architectural dimensions on this floor plan.
Return absolute pixel coordinates in this ${visionW}×${visionH} image (origin top-left).
Return JSON only:
{
  "width": ${visionW},
  "height": ${visionH},
  "dimensions": [
    {
      "id": "d1",
      "valueText": "13'-0\\"",
      "valueInches": 156,
      "labelBBox": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "span": { "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } },
      "dimGraphics": {
        "dimLine": { "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } },
        "extensionA": { "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } },
        "extensionB": { "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } }
      },
      "confidence": 0.0,
      "alternateSpans": [],
      "notes": "optional"
    }
  ]
}

valueInches must be total inches. labelBBox around the digits. span.a/span.b are the
measured endpoints on the building geometry (wall corners/faces), not the text.`;

  const text = await client.complete({
    system: SYSTEM,
    prompt,
    images: [{ data: send, mediaType }],
    json: true,
  });
  const payload = parseJsonBlock<ExtractPayload>(text);
  const dims = payload.dimensions ?? [];
  const out: DimReading[] = [];
  dims.forEach((d, i) => {
    const n = normalizeReading(d, i, visionW, visionH, origW, origH);
    if (n) out.push(n);
  });
  const resizeNote = didResize
    ? `Pre-resized ${origW}×${origH} → ${visionW}×${visionH} (Claude ${client.model} tier); coords scaled back to original`
    : undefined;
  return { readings: out, resizeNote };
}

/** Crop tiles covering the image for a second-pass zoom extract. */
async function tileImage(png: Buffer, tile = 1024, overlap = 128): Promise<
  { buf: Buffer; ox: number; oy: number; tw: number; th: number }[]
> {
  const { width, height } = await imageMeta(png);
  const tiles = [];
  const step = tile - overlap;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const tw = Math.min(tile, width - x);
      const th = Math.min(tile, height - y);
      if (tw < 200 || th < 200) continue;
      const buf = await sharp(png).extract({ left: x, top: y, width: tw, height: th }).png().toBuffer();
      tiles.push({ buf, ox: x, oy: y, tw, th });
    }
  }
  return tiles;
}

function offsetReading(r: DimReading, ox: number, oy: number, prefix: string): DimReading {
  const shift = (p: Point): Point => ({ x: p.x + ox, y: p.y + oy });
  const shiftSeg = (s: { a: Point; b: Point }) => ({ a: shift(s.a), b: shift(s.b) });
  return {
    ...r,
    id: `${prefix}-${r.id}`,
    labelBBox: {
      x: r.labelBBox.x + ox,
      y: r.labelBBox.y + oy,
      w: r.labelBBox.w,
      h: r.labelBBox.h,
    },
    span: { a: shift(r.span.a), b: shift(r.span.b) },
    alternateSpans: r.alternateSpans?.map(shiftSeg),
    dimGraphics: r.dimGraphics
      ? {
          dimLine: r.dimGraphics.dimLine ? shiftSeg(r.dimGraphics.dimLine) : undefined,
          extensionA: r.dimGraphics.extensionA ? shiftSeg(r.dimGraphics.extensionA) : undefined,
          extensionB: r.dimGraphics.extensionB ? shiftSeg(r.dimGraphics.extensionB) : undefined,
        }
      : undefined,
  };
}

function mergeReadings(all: DimReading[]): DimReading[] {
  const kept: DimReading[] = [];
  for (const r of all) {
    const dup = kept.find((k) => {
      const sameVal = Math.abs(k.valueInches - r.valueInches) < 0.6;
      const labelDist = Math.hypot(
        k.labelBBox.x + k.labelBBox.w / 2 - (r.labelBBox.x + r.labelBBox.w / 2),
        k.labelBBox.y + k.labelBBox.h / 2 - (r.labelBBox.y + r.labelBBox.h / 2),
      );
      return sameVal && labelDist < 40;
    });
    if (!dup) {
      kept.push(r);
      continue;
    }
    // Prefer higher confidence / keep alternate spans
    if ((r.confidence ?? 0) > (dup.confidence ?? 0)) {
      const alts = [...(dup.alternateSpans ?? []), dup.span, ...(r.alternateSpans ?? [])];
      Object.assign(dup, r, {
        alternateSpans: alts.length ? alts : undefined,
      });
    } else if (r.span) {
      dup.alternateSpans = [...(dup.alternateSpans ?? []), r.span];
    }
  }
  return kept.map((r, i) => ({ ...r, id: `dim-${i + 1}` }));
}

export interface ExtractDimensionsResult {
  readings: DimReading[];
  /** Cleaned dims-only PNG at original size when redraw succeeded. */
  cleanedPng: Buffer | null;
  cleanedStatus: ImageCleanStatus;
  notes: string[];
}

/**
 * Multi-pass dimension extraction with a Nano Banana dims-only redraw first.
 * 1) Gemini image model redraws dimensions/measurement lines only → PNG artifact
 * 2) Dim readings from that cleaned image (fallback: original)
 * Layout/align stay on originals (caller responsibility).
 */
export async function extractDimensions(
  png: Buffer,
  opts?: { client?: VisionClient | null; tiles?: boolean; skipClean?: boolean },
): Promise<ExtractDimensionsResult> {
  const notes: string[] = [];
  const client = opts?.client === undefined ? createVisionClient() : opts.client;
  if (!client) {
    notes.push(
      "No ANTHROPIC_API_KEY or OPENAI_API_KEY — skipped vision dim extraction. Provide gold dims or set a key.",
    );
    return {
      readings: [],
      cleanedPng: null,
      cleanedStatus: "skipped",
      notes,
    };
  }
  notes.push(`Vision provider: ${client.provider} / ${client.model}`);

  let cleanedPng: Buffer | null = null;
  let cleanedStatus: ImageCleanStatus = "skipped";
  let source = png;

  if (!opts?.skipClean) {
    const redraw = await redrawDimsClean(png);
    notes.push(...redraw.notes);
    cleanedStatus = redraw.status;
    if (redraw.cleanedPng) {
      cleanedPng = redraw.cleanedPng;
      source = redraw.cleanedPng;
      notes.push("Dim extract running on cleaned dims redraw");
    } else if (redraw.status === "fallback") {
      notes.push("Dim extract falling back to original image");
    }
  }

  let full: DimReading[] = [];
  try {
    const pass = await extractPass(client, source, "full-page");
    full = pass.readings;
    if (pass.resizeNote) notes.push(pass.resizeNote);
    notes.push(`Full-page pass found ${full.length} dimension(s)`);
  } catch (e) {
    notes.push(`Full-page extract failed: ${(e as Error).message}`);
  }

  let tiled: DimReading[] = [];
  if (opts?.tiles !== false) {
    const tiles = await tileImage(source);
    // Cap tiles for very large images but plan says spare no expense — still bound to 12
    const use = tiles.slice(0, 12);
    for (let i = 0; i < use.length; i++) {
      const t = use[i]!;
      try {
        const pass = await extractPass(client, t.buf, `tile-${i} @(${t.ox},${t.oy})`);
        tiled.push(...pass.readings.map((r) => offsetReading(r, t.ox, t.oy, `t${i}`)));
      } catch (e) {
        notes.push(`Tile ${i} extract failed: ${(e as Error).message}`);
      }
    }
    notes.push(`Tile passes contributed ${tiled.length} raw reading(s)`);
  } else {
    notes.push("Tiled zoom passes skipped (one-shot mode)");
  }

  // Confirmation pass on low-confidence (skipped in one-shot mode — still crops).
  const merged = mergeReadings([...full, ...tiled]);
  if (opts?.tiles === false) {
    notes.push(`One-shot merge kept ${merged.length} dimension(s); confirm crops skipped`);
    return { readings: merged, cleanedPng, cleanedStatus, notes };
  }

  const uncertain = merged.filter((r) => (r.confidence ?? 0.5) < 0.65);
  for (const u of uncertain.slice(0, 8)) {
    try {
      const pad = 80;
      const { width, height } = await imageMeta(source);
      const left = Math.max(0, Math.floor(u.labelBBox.x - pad));
      const top = Math.max(0, Math.floor(u.labelBBox.y - pad));
      const widthC = Math.min(width - left, Math.ceil(u.labelBBox.w + pad * 2 + Math.abs(u.span.b.x - u.span.a.x)));
      const heightC = Math.min(
        height - top,
        Math.ceil(u.labelBBox.h + pad * 2 + Math.abs(u.span.b.y - u.span.a.y)),
      );
      if (widthC < 40 || heightC < 40) continue;
      const crop = await sharp(source)
        .extract({ left, top, width: widthC, height: heightC })
        .png()
        .toBuffer();
      const pass = await extractPass(client, crop, `confirm-${u.id}`);
      if (pass.readings[0]) {
        const c = offsetReading(pass.readings[0], left, top, "c");
        u.valueInches = c.valueInches;
        u.valueText = c.valueText ?? u.valueText;
        u.span = c.span;
        u.labelBBox = c.labelBBox;
        u.alternateSpans = [
          ...(u.alternateSpans ?? []),
          ...(c.alternateSpans ?? []),
        ];
        u.confidence = Math.max(u.confidence ?? 0, c.confidence ?? 0.7, 0.75);
      }
    } catch (e) {
      notes.push(`Confirm pass for ${u.id} failed: ${(e as Error).message}`);
    }
  }

  return { readings: merged, cleanedPng, cleanedStatus, notes };
}

/** Vision pass for holistic topology notes between two aligned images. */
export async function visionTopologyFindings(
  referencePng: Buffer,
  alignedCandidatePng: Buffer,
  client?: VisionClient | null,
): Promise<{ findings: import("../types").Finding[]; notes: string[] }> {
  const notes: string[] = [];
  const c = client === undefined ? createVisionClient() : client;
  if (!c) {
    notes.push("No vision client — skipped topology vision pass");
    return { findings: [], notes };
  }
  const prompt = `Image 1 is the REFERENCE floor plan. Image 2 is the CANDIDATE aligned into the same frame.
Ignore dimension text; focus on walls, rooms, doors, windows, fixtures.
List structural differences as JSON:
{
  "findings": [
    {
      "id": "topo-1",
      "kind": "topology",
      "message": "…",
      "severity": "error" | "warn" | "info",
      "referenceBBox": { "x": 0, "y": 0, "w": 0, "h": 0 }
    }
  ]
}
Only real differences. Empty array if they match.`;

  try {
    const text = await c.complete({
      system: SYSTEM,
      prompt,
      images: [
        { data: referencePng, mediaType: "image/png" },
        { data: alignedCandidatePng, mediaType: "image/png" },
      ],
      json: true,
    });
    const payload = parseJsonBlock<{
      findings: {
        id: string;
        kind?: string;
        message: string;
        severity?: "error" | "warn" | "info";
        referenceBBox?: BBox;
      }[];
    }>(text);
    const findings = (payload.findings ?? []).map((f) => ({
      id: f.id,
      kind: "topology" as const,
      message: f.message,
      severity: f.severity ?? "warn",
      referenceBBox: f.referenceBBox,
      alignedBBox: f.referenceBBox,
      status: "provisional" as const,
    }));
    notes.push(`Vision topology: ${findings.length} finding(s)`);
    return { findings, notes };
  } catch (e) {
    notes.push(`Vision topology failed: ${(e as Error).message}`);
    return { findings: [], notes };
  }
}
