import sharp from "sharp";
import type { DimReading, Finding, Point, StructureReading } from "./types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function line(
  a: Point,
  b: Point,
  color: string,
  width = 3,
  dash?: string,
): string {
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ""} stroke-linecap="round"/>`;
}

function handle(p: Point, color: string): string {
  return `<circle cx="${p.x}" cy="${p.y}" r="7" fill="${color}" stroke="#fff" stroke-width="2"/>`;
}

/** Draw junctions + wall spans onto a base PNG (reference pixel space). */
export async function drawStructureOverlay(
  basePng: Buffer,
  structure: StructureReading,
  opts?: { title?: string },
): Promise<Buffer> {
  const meta = await sharp(basePng).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const parts: string[] = [];
  for (const span of structure.wallSpans) {
    parts.push(line(span.a, span.b, "#0f766e", 4));
  }
  for (const j of structure.junctions) {
    parts.push(handle(j.point, "#f97316"));
    parts.push(
      `<text x="${j.point.x + 10}" y="${j.point.y - 8}" font-size="12" font-family="ui-monospace,monospace" fill="#ea580c">${esc(j.id)}</text>`,
    );
  }
  if (opts?.title) {
    parts.push(
      `<text x="16" y="28" font-size="18" font-family="system-ui,sans-serif" fill="#111">${esc(opts.title)}</text>`,
    );
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  ${parts.join("\n  ")}
</svg>`;
  const overlayPng = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(basePng)
    .composite([{ input: overlayPng, blend: "over" }])
    .png()
    .toBuffer();
}

/** Draw dim readings + findings onto a base PNG (reference pixel space). */
export async function drawDimsOverlay(
  basePng: Buffer,
  dims: DimReading[],
  findings: Finding[],
  opts?: { title?: string },
): Promise<Buffer> {
  const meta = await sharp(basePng).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  const parts: string[] = [];
  for (const d of dims) {
    const color = d.verified ? "#16a34a" : "#2563eb";
    parts.push(line(d.span.a, d.span.b, color, 3));
    parts.push(handle(d.span.a, color));
    parts.push(handle(d.span.b, color));
    const lx = d.labelBBox.x;
    const ly = d.labelBBox.y;
    parts.push(
      `<rect x="${lx}" y="${ly}" width="${d.labelBBox.w}" height="${d.labelBBox.h}" fill="none" stroke="${color}" stroke-width="2"/>`,
    );
    parts.push(
      `<text x="${lx}" y="${Math.max(12, ly - 4)}" font-size="14" font-family="ui-monospace,monospace" fill="${color}">${esc(d.valueText ?? String(d.valueInches))}${d.verified ? " ✓" : ""}</text>`,
    );
    for (const alt of d.alternateSpans ?? []) {
      parts.push(line(alt.a, alt.b, "#f59e0b", 2, "6 4"));
    }
  }

  for (const f of findings) {
    const b = f.alignedBBox ?? f.referenceBBox;
    if (!b) continue;
    const stroke =
      f.kind === "dim_span_mismatch"
        ? "#dc2626"
        : f.kind.startsWith("dim_")
          ? "#ea580c"
          : "#7c3aed";
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${stroke}22" stroke="${stroke}" stroke-width="2" stroke-dasharray="8 4"/>`,
    );
  }

  if (opts?.title) {
    parts.push(
      `<text x="16" y="28" font-size="18" font-family="system-ui,sans-serif" fill="#111">${esc(opts.title)}</text>`,
    );
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  ${parts.join("\n  ")}
</svg>`;

  const overlayPng = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(basePng)
    .composite([{ input: overlayPng, blend: "over" }])
    .png()
    .toBuffer();
}
