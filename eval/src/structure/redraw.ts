import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { imageMeta } from "../vision/prepare";

/** User-validated prompt that produced near-perfect walls-only rasters. */
export const STRUCTURE_REDRAW_PROMPT =
  "Redraw this at exactly the same size but showing only the walls, windows and doors, Remove all other clutter from the image like dimensions and measurement lines.";

/** User-validated prompt for dimensions/measurement-lines-only rasters. */
export const DIMS_REDRAW_PROMPT =
  "Redraw this at exactly the same size but showing only the dimensions and measurement lines, Remove all other clutter from the image like walls, windows and doors.";

/**
 * Nano Banana Pro — Gemini 3 Pro Image.
 * (Not gemini-3.1-pro-image; Pro image is the 3.x Pro family, Flash is 3.1.)
 * Override via EVAL_IMAGE_REDRAW_MODEL / EVAL_STRUCTURE_REDRAW_MODEL / GEMINI_IMAGE_MODEL.
 */
const DEFAULT_MODEL = "gemini-3-pro-image";

/** Cap long edge before send; model tops out around 4K. Scale result back to original. */
const MAX_LONG_EDGE = 4096;

export type ImageCleanStatus = "ok" | "cached" | "fallback" | "skipped";
/** @deprecated Prefer ImageCleanStatus */
export type StructureCleanStatus = ImageCleanStatus;

export interface ImageCleanResult {
  /** Cleaned PNG at original input pixel size, or null on failure/skip. */
  cleanedPng: Buffer | null;
  status: ImageCleanStatus;
  notes: string[];
  model?: string;
}

/** @deprecated Prefer ImageCleanResult */
export type StructureCleanResult = ImageCleanResult;

export interface ImageCleanOpts {
  prompt: string;
  label: string;
  /**
   * Durable cache path (e.g. caseDir/cleaned/structure_ref.png).
   * When present and EVAL_FORCE_REDRAW is unset, load instead of calling Nano Banana.
   * On successful redraw, also write here.
   */
  cachePath?: string;
}

export function resolveGeminiApiKey(): string | null {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENAI_API_KEY?.trim() ||
    null
  );
}

export function resolveNanoBananaModel(): string {
  return (
    process.env.EVAL_IMAGE_REDRAW_MODEL?.trim() ||
    process.env.EVAL_STRUCTURE_REDRAW_MODEL?.trim() ||
    process.env.GEMINI_IMAGE_MODEL?.trim() ||
    DEFAULT_MODEL
  );
}

export function forceRedrawCleaned(): boolean {
  const v = process.env.EVAL_FORCE_REDRAW?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function prepareForNanoBanana(png: Buffer): Promise<{
  send: Buffer;
  origW: number;
  origH: number;
  sendW: number;
  sendH: number;
  didResize: boolean;
}> {
  const { width: origW, height: origH } = await imageMeta(png);
  const long = Math.max(origW, origH);
  if (long <= MAX_LONG_EDGE) {
    return { send: png, origW, origH, sendW: origW, sendH: origH, didResize: false };
  }
  const scale = MAX_LONG_EDGE / long;
  const sendW = Math.max(1, Math.round(origW * scale));
  const sendH = Math.max(1, Math.round(origH * scale));
  const send = await sharp(png).resize(sendW, sendH, { fit: "fill" }).png().toBuffer();
  return { send, origW, origH, sendW, sendH, didResize: true };
}

function tryLoadCachedCleaned(
  cachePath: string | undefined,
  label: string,
): ImageCleanResult | null {
  if (!cachePath || forceRedrawCleaned()) return null;
  if (!existsSync(cachePath)) return null;
  try {
    const cleanedPng = readFileSync(cachePath);
    if (cleanedPng.length < 100) return null;
    return {
      cleanedPng,
      status: "cached",
      notes: [`${label} cleaned loaded from cache: ${cachePath}`],
    };
  } catch {
    return null;
  }
}

function persistCleanedCache(cachePath: string | undefined, png: Buffer, notes: string[]): void {
  if (!cachePath) return;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, png);
    notes.push(`${labelOrPath(cachePath)} cached → ${cachePath}`);
  } catch (e) {
    notes.push(`Failed to write cleaned cache ${cachePath}: ${(e as Error).message}`);
  }
}

function labelOrPath(p: string): string {
  const base = p.split("/").pop() ?? p;
  return `Cleaned ${base}`;
}

/**
 * Shared Nano Banana (Gemini image edit) redraw helper.
 * Returns a PNG at the original pixel size when successful.
 */
export async function redrawImageClean(
  png: Buffer,
  opts: ImageCleanOpts,
): Promise<ImageCleanResult> {
  const notes: string[] = [];
  const label = opts.label;

  const cached = tryLoadCachedCleaned(opts.cachePath, label);
  if (cached) return cached;

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    notes.push(
      `No GEMINI_API_KEY / GOOGLE_API_KEY — skipped ${label} redraw (Nano Banana). Set GEMINI_API_KEY to enable.`,
    );
    return { cleanedPng: null, status: "skipped", notes };
  }

  const model = resolveNanoBananaModel();
  notes.push(`${label} redraw: google / ${model} (Nano Banana)`);

  try {
    const prepared = await prepareForNanoBanana(png);
    if (prepared.didResize) {
      notes.push(
        `Redraw pre-resized ${prepared.origW}×${prepared.origH} → ${prepared.sendW}×${prepared.sendH}`,
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const interaction = await ai.interactions.create({
      model,
      input: [
        { type: "text", text: opts.prompt },
        {
          type: "image",
          mime_type: "image/png",
          data: prepared.send.toString("base64"),
        },
      ],
      // Prefer image output; model still matches input size by default.
      response_modalities: ["image"],
    });

    const generated = interaction.output_image;
    if (!generated?.data) {
      const hint = interaction.output_text?.slice(0, 240) ?? "(no text)";
      throw new Error(`No image in Nano Banana response: ${hint}`);
    }

    let out = Buffer.from(generated.data, "base64");
    // Normalize to PNG and force original dimensions for overlay/extract alignment.
    const outMeta = await imageMeta(out);
    if (outMeta.width !== prepared.origW || outMeta.height !== prepared.origH) {
      notes.push(
        `Redraw model size ${outMeta.width}×${outMeta.height} → resize to ${prepared.origW}×${prepared.origH}`,
      );
      out = await sharp(out)
        .resize(prepared.origW, prepared.origH, { fit: "fill" })
        .png()
        .toBuffer();
    } else {
      out = await sharp(out).png().toBuffer();
    }

    const meta = await imageMeta(out);
    notes.push(
      `${label} redraw ok → cleaned ${meta.width}×${meta.height} (orig ${prepared.origW}×${prepared.origH})`,
    );
    persistCleanedCache(opts.cachePath, out, notes);
    return { cleanedPng: out, status: "ok", notes, model };
  } catch (e) {
    notes.push(
      `${label} redraw failed: ${(e as Error).message} — using original image`,
    );
    return { cleanedPng: null, status: "fallback", notes, model };
  }
}

/** Walls/windows/doors-only redraw. */
export async function redrawStructureClean(
  png: Buffer,
  opts?: { cachePath?: string },
): Promise<ImageCleanResult> {
  return redrawImageClean(png, {
    prompt: STRUCTURE_REDRAW_PROMPT,
    label: "Structure",
    cachePath: opts?.cachePath,
  });
}

/** Dimensions/measurement-lines-only redraw. */
export async function redrawDimsClean(
  png: Buffer,
  opts?: { cachePath?: string },
): Promise<ImageCleanResult> {
  return redrawImageClean(png, {
    prompt: DIMS_REDRAW_PROMPT,
    label: "Dims",
    cachePath: opts?.cachePath,
  });
}
