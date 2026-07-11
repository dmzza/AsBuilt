import sharp from "sharp";
import type { BBox, Point } from "./types";

export interface ImageSize {
  width: number;
  height: number;
}

export async function imageSize(buf: Buffer): Promise<ImageSize> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

export async function toRgba(buf: Buffer): Promise<{
  width: number;
  height: number;
  data: Buffer;
}> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

export async function encodePng(
  width: number,
  height: number,
  rgba: Buffer,
): Promise<Buffer> {
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Luminance edge magnitude map (0–255), simple Sobel-ish. */
export function edgeMap(
  width: number,
  height: number,
  rgba: Buffer,
): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    gray[i] = 0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0);
  }
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -(gray[i - width - 1] ?? 0) +
        (gray[i - width + 1] ?? 0) -
        2 * (gray[i - 1] ?? 0) +
        2 * (gray[i + 1] ?? 0) -
        (gray[i + width - 1] ?? 0) +
        (gray[i + width + 1] ?? 0);
      const gy =
        -(gray[i - width - 1] ?? 0) -
        2 * (gray[i - width] ?? 0) -
        (gray[i - width + 1] ?? 0) +
        (gray[i + width - 1] ?? 0) +
        2 * (gray[i + width] ?? 0) +
        (gray[i + width + 1] ?? 0);
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** Ink mask: dark-ish pixels (hand drawings / CAD lines on light paper). */
export function inkMask(
  width: number,
  height: number,
  rgba: Buffer,
  threshold = 200,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const y = 0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0);
    mask[i] = y < threshold ? 1 : 0;
  }
  return mask;
}

export function inkCentroid(
  width: number,
  height: number,
  mask: Uint8Array,
): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n === 0) return { x: width / 2, y: height / 2 };
  return { x: sx / n, y: sy / n };
}

export function inkBBox(
  width: number,
  height: number,
  mask: Uint8Array,
): BBox {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      any = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!any) return { x: 0, y: 0, w: width, h: height };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function spanBBox(a: Point, b: Point, pad = 8): BBox {
  const x1 = Math.min(a.x, b.x) - pad;
  const y1 = Math.min(a.y, b.y) - pad;
  const x2 = Math.max(a.x, b.x) + pad;
  const y2 = Math.max(a.y, b.y) + pad;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Parse architectural length text to inches. Returns null if unparseable. */
export function parseDimText(text: string): number | null {
  const t = text.trim().replace(/\s+/g, " ");
  // 13'-0" | 13'0" | 13'-0 | 11'-8 1/2" | 6 1/2" | 140.5"
  const feetInches = t.match(
    /^(-?\d+)\s*'\s*-?\s*(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*"?$/,
  );
  if (feetInches) {
    const feet = Number(feetInches[1]);
    let inches = Number(feetInches[2]);
    if (feetInches[3] && feetInches[4]) {
      inches += Number(feetInches[3]) / Number(feetInches[4]);
    }
    return feet * 12 + inches;
  }
  const inchesOnly = t.match(/^(-?\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*"$/);
  if (inchesOnly) {
    let inches = Number(inchesOnly[1]);
    if (inchesOnly[2] && inchesOnly[3]) {
      inches += Number(inchesOnly[2]) / Number(inchesOnly[3]);
    }
    return inches;
  }
  const bareFeet = t.match(/^(-?\d+(?:\.\d+)?)\s*'$/);
  if (bareFeet) return Number(bareFeet[1]) * 12;
  return null;
}

export function formatInches(inches: number): string {
  const sign = inches < 0 ? "-" : "";
  const abs = Math.abs(inches);
  const feet = Math.floor(abs / 12);
  const rem = abs - feet * 12;
  const whole = Math.floor(rem);
  const frac = rem - whole;
  let fracStr = "";
  const sixteenths = Math.round(frac * 16);
  if (sixteenths > 0 && sixteenths < 16) {
    const g = gcd(sixteenths, 16);
    fracStr = ` ${sixteenths / g}/${16 / g}`;
  } else if (sixteenths === 16) {
    return formatInches((feet * 12 + whole + 1) * (inches < 0 ? -1 : 1));
  }
  if (feet === 0) return `${sign}${whole}${fracStr}"`;
  return `${sign}${feet}'-${whole}${fracStr}"`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
