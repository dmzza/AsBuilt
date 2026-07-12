import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { imageMeta } from "../vision/prepare";

/** User-validated prompt that produced near-perfect walls-only rasters. */
const PROMPT =
  "Redraw this at exactly the same size but showing only the walls, windows and doors, Remove all other clutter from the image like dimensions and measurement lines.";

/** Nano Banana 2 — Gemini 3.1 Flash Image (override via EVAL_STRUCTURE_REDRAW_MODEL). */
const DEFAULT_MODEL = "gemini-3.1-flash-image";

/** Cap long edge before send; model tops out around 4K. Scale result back to original. */
const MAX_LONG_EDGE = 4096;

export type StructureCleanStatus = "ok" | "fallback" | "skipped";

export interface StructureCleanResult {
  /** Cleaned PNG at original input pixel size, or null on failure/skip. */
  cleanedPng: Buffer | null;
  status: StructureCleanStatus;
  notes: string[];
  model?: string;
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
    process.env.EVAL_STRUCTURE_REDRAW_MODEL?.trim() ||
    process.env.GEMINI_IMAGE_MODEL?.trim() ||
    DEFAULT_MODEL
  );
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

/**
 * Walls/windows/doors-only redraw via Nano Banana (Gemini image edit).
 * Returns a PNG at the original pixel size when successful.
 */
export async function redrawStructureClean(png: Buffer): Promise<StructureCleanResult> {
  const notes: string[] = [];
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    notes.push(
      "No GEMINI_API_KEY / GOOGLE_API_KEY — skipped structure redraw (Nano Banana). Set GEMINI_API_KEY to enable.",
    );
    return { cleanedPng: null, status: "skipped", notes };
  }

  const model = resolveNanoBananaModel();
  notes.push(`Structure redraw: google / ${model} (Nano Banana)`);

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
        { type: "text", text: PROMPT },
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
      `Structure redraw ok → cleaned ${meta.width}×${meta.height} (orig ${prepared.origW}×${prepared.origH})`,
    );
    return { cleanedPng: out, status: "ok", notes, model };
  } catch (e) {
    notes.push(
      `Structure redraw failed: ${(e as Error).message} — using original image`,
    );
    return { cleanedPng: null, status: "fallback", notes, model };
  }
}
