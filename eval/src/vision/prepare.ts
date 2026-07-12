import sharp from "sharp";
import { resizedSizeForModel } from "./resize";

export async function imageMeta(buf: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(buf).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/**
 * Pre-resize to the exact size Claude would use for this model so returned
 * pixel coords match the buffer we send; caller maps back to original.
 * @see https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
 */
export async function prepareVisionImage(
  png: Buffer,
  model: string,
): Promise<{
  send: Buffer;
  mediaType: "image/png";
  origW: number;
  origH: number;
  visionW: number;
  visionH: number;
  didResize: boolean;
}> {
  const { width: origW, height: origH } = await imageMeta(png);
  const [visionW, visionH] = resizedSizeForModel(origW, origH, model);
  if (visionW === origW && visionH === origH) {
    return {
      send: png,
      mediaType: "image/png",
      origW,
      origH,
      visionW,
      visionH,
      didResize: false,
    };
  }
  const send = await sharp(png)
    .resize(visionW, visionH, { fit: "fill" })
    .png()
    .toBuffer();
  return {
    send,
    mediaType: "image/png",
    origW,
    origH,
    visionW,
    visionH,
    didResize: true,
  };
}
