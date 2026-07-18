/**
 * Headless AsBuilt plan renderer: Pipeline → SVG → PNG.
 * Adapter only — the fidelity scorer never imports this.
 */
import { Resvg } from "@resvg/resvg-js";
import {
  formatLength,
  junctionPos,
  layerMap,
  loadProject,
  openingViews,
  resolveAndSolve,
  s64FromInches,
  wallView,
  fixtureViews,
  type Pipeline,
  type WallView,
} from "../../src/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PAPER = "#f5f3ec";
const INK = "#35322b";
const DIM = "#1d4ed8";

/** Raster scale applied by svgToPng (resvg zoom). Pixel coords = SVG × scale. */
export const ABL_PNG_SCALE = 2;

export type AblRenderLayer = "full" | "structure" | "dims";

export interface RenderOptions {
  /** Pixels per inch (SVG space, before ABL_PNG_SCALE). */
  ppi?: number;
  padding?: number;
  branch?: string;
  showDims?: boolean;
  width?: number;
  height?: number;
  /** Which visual layer to draw. Default "full". */
  layer?: AblRenderLayer;
}

/** Shared inch→pixel projection for SVG, PNG, and JSON serializers. */
export interface AblFrame {
  ppi: number;
  pad: number;
  /** PNG scale factor (matches svgToPng). */
  scale: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  svgW: number;
  svgH: number;
  /** World inches → SVG pixels. */
  tx: (x: number) => number;
  ty: (y: number) => number;
  /** World inches → PNG pixels (after resvg scale). */
  px: (x: number) => number;
  py: (y: number) => number;
}

function collectAblFiles(path: string, root: string, out: Map<string, string>): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry.startsWith(".")) continue;
      collectAblFiles(join(path, entry), root, out);
    }
  } else if (path.endsWith(".abl")) {
    out.set(relative(root, path), readFileSync(path, "utf8"));
  }
}

export function loadAblProjectDir(dir: string): Record<string, string> {
  const files = new Map<string, string>();
  collectAblFiles(dir, dir, files);
  if (files.size === 0) throw new Error(`no .abl files in ${dir}`);
  return Object.fromEntries(files);
}

export function allWalls(p: Pipeline): WallView[] {
  const out: WallView[] = [];
  for (const [key, eff] of p.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    const v = wallView(p, key);
    if (v) out.push(v);
  }
  return out;
}

export function prepareAblFrame(p: Pipeline, opts: RenderOptions = {}): AblFrame {
  const ppi = opts.ppi ?? 4;
  const pad = opts.padding ?? 48;
  const scale = ABL_PNG_SCALE;
  const walls = allWalls(p);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y);
    maxX = Math.max(maxX, w.a.x, w.b.x);
    maxY = Math.max(maxY, w.a.y, w.b.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }

  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const svgW = opts.width ?? Math.ceil(worldW * ppi + pad * 2);
  const svgH = opts.height ?? Math.ceil(worldH * ppi + pad * 2);

  const tx = (x: number) => pad + (x - minX) * ppi;
  // Screen y grows down; plan y grows north — flip
  const ty = (y: number) => pad + (maxY - y) * ppi;

  return {
    ppi,
    pad,
    scale,
    minX,
    minY,
    maxX,
    maxY,
    svgW,
    svgH,
    tx,
    ty,
    px: (x: number) => tx(x) * scale,
    py: (y: number) => ty(y) * scale,
  };
}

export interface DimAnnotation {
  id: string;
  /** World-inch endpoints. */
  a: { x: number; y: number };
  b: { x: number; y: number };
  valueInches: number;
  valueText: string;
}

/** Shared label / dim-line placement in SVG space (pre-scale). */
export function placeDimAnnotation(
  frame: AblFrame,
  ann: DimAnnotation,
): {
  spanSvg: { a: { x: number; y: number }; b: { x: number; y: number } };
  labelSvg: { x: number; y: number; w: number; h: number };
  dimLine: { a: { x: number; y: number }; b: { x: number; y: number } };
  extensionA: { a: { x: number; y: number }; b: { x: number; y: number } };
  extensionB: { a: { x: number; y: number }; b: { x: number; y: number } };
} {
  const ax = frame.tx(ann.a.x);
  const ay = frame.ty(ann.a.y);
  const bx = frame.tx(ann.b.x);
  const by = frame.ty(ann.b.y);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Offset perpendicular in screen space (prefer "above" the span).
  let nx = -uy;
  let ny = ux;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const offset = 18;
  const ext = 6;
  const da = { x: ax + nx * offset, y: ay + ny * offset };
  const db = { x: bx + nx * offset, y: by + ny * offset };
  const tw = Math.max(54, ann.valueText.length * 8 + 20);
  const th = 18;
  const mx = (da.x + db.x) / 2;
  const my = (da.y + db.y) / 2;
  return {
    spanSvg: { a: { x: ax, y: ay }, b: { x: bx, y: by } },
    labelSvg: { x: mx - tw / 2, y: my - th / 2 - 2, w: tw, h: th },
    dimLine: { a: da, b: db },
    extensionA: {
      a: { x: ax + nx * ext, y: ay + ny * ext },
      b: { x: da.x + nx * 2, y: da.y + ny * 2 },
    },
    extensionB: {
      a: { x: bx + nx * ext, y: by + ny * ext },
      b: { x: db.x + nx * 2, y: db.y + ny * 2 },
    },
  };
}

export function pipelineToSvg(
  p: Pipeline,
  opts: RenderOptions = {},
  annotations?: DimAnnotation[],
): string {
  const layer = opts.layer ?? "full";
  const frame = prepareAblFrame(p, opts);
  const { tx, ty, svgW, svgH, ppi, pad, minX, minY, maxX, maxY } = frame;
  const walls = allWalls(p);
  const openings = openingViews(p);
  const fixtures = fixtureViews(p);

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${PAPER}"/>`,
  );

  if (layer === "full") {
    const grid = 12; // inches
    for (let x = Math.floor(minX / grid) * grid; x <= maxX; x += grid) {
      const px = tx(x);
      parts.push(
        `<line x1="${px}" y1="${pad}" x2="${px}" y2="${svgH - pad}" stroke="#e2dfd1" stroke-width="1"/>`,
      );
    }
    for (let y = Math.floor(minY / grid) * grid; y <= maxY; y += grid) {
      const py = ty(y);
      parts.push(
        `<line x1="${pad}" y1="${py}" x2="${svgW - pad}" y2="${py}" stroke="#e2dfd1" stroke-width="1"/>`,
      );
    }
  }

  if (layer === "full" || layer === "structure") {
    for (const w of walls) {
      const thick = 6;
      parts.push(
        `<line x1="${tx(w.a.x)}" y1="${ty(w.a.y)}" x2="${tx(w.b.x)}" y2="${ty(w.b.y)}" stroke="${INK}" stroke-width="${thick}" stroke-linecap="square"/>`,
      );
      if (layer === "full" && opts.showDims !== false) {
        const mx = (w.a.x + w.b.x) / 2;
        const my = (w.a.y + w.b.y) / 2;
        const label = formatLength(s64FromInches(Math.round(w.lengthInches * 16) / 16));
        parts.push(
          `<text x="${tx(mx)}" y="${ty(my) - 8}" text-anchor="middle" font-size="13" font-family="ui-monospace,monospace" fill="${DIM}">${escapeXml(label)}</text>`,
        );
      }
    }

    const seen = new Set<string>();
    for (const w of walls) {
      for (const name of [w.from, w.to]) {
        if (seen.has(name)) continue;
        seen.add(name);
        const j = junctionPos(p.solution, name);
        if (!j) continue;
        parts.push(
          `<circle cx="${tx(j.x)}" cy="${ty(j.y)}" r="5" fill="#fff" stroke="${INK}" stroke-width="2"/>`,
        );
      }
    }

    for (const op of openings) {
      const x1 = tx(op.jambA.x);
      const y1 = ty(op.jambA.y);
      const x2 = tx(op.jambB.x);
      const y2 = ty(op.jambB.y);
      parts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${PAPER}" stroke-width="8"/>`,
      );
      parts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8b8779" stroke-width="2" stroke-dasharray="4 3"/>`,
      );
    }
  }

  if (layer === "full") {
    for (const f of fixtures) {
      const x = tx(f.x);
      const y = ty(f.y);
      const hw = (f.w * ppi) / 2;
      const hd = (f.d * ppi) / 2;
      parts.push(
        `<rect x="${x - hw}" y="${y - hd}" width="${hw * 2}" height="${hd * 2}" fill="none" stroke="${INK}" stroke-width="1.5"/>`,
      );
      parts.push(
        `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-family="Georgia,serif" fill="#6d6a5f">${escapeXml(f.fixKind)}</text>`,
      );
    }
  }

  if (layer === "dims" && annotations) {
    for (const ann of annotations) {
      const place = placeDimAnnotation(frame, ann);
      const { dimLine, extensionA, extensionB, labelSvg } = place;
      parts.push(
        `<line x1="${extensionA.a.x}" y1="${extensionA.a.y}" x2="${extensionA.b.x}" y2="${extensionA.b.y}" stroke="${DIM}" stroke-width="1"/>`,
      );
      parts.push(
        `<line x1="${extensionB.a.x}" y1="${extensionB.a.y}" x2="${extensionB.b.x}" y2="${extensionB.b.y}" stroke="${DIM}" stroke-width="1"/>`,
      );
      parts.push(
        `<line x1="${dimLine.a.x}" y1="${dimLine.a.y}" x2="${dimLine.b.x}" y2="${dimLine.b.y}" stroke="${DIM}" stroke-width="1.5"/>`,
      );
      parts.push(
        `<text x="${labelSvg.x + labelSvg.w / 2}" y="${labelSvg.y + labelSvg.h - 4}" text-anchor="middle" font-size="12" font-family="ui-monospace,monospace" fill="${DIM}">${escapeXml(ann.valueText)}</text>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">
  ${parts.join("\n  ")}
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function svgToPng(svg: string, scale = ABL_PNG_SCALE): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(resvg.render().asPng());
}

function solveProject(
  files: Record<string, string>,
  opts: RenderOptions,
): { pipeline: Pipeline; branch: string } {
  const project = loadProject(files);
  const branch = opts.branch ?? [...project.layers.keys()][0];
  if (!branch) throw new Error("no layers in project");
  const pipeline = resolveAndSolve(layerMap(project), branch);
  return { pipeline, branch };
}

export function renderAblProjectToPng(
  projectDir: string,
  opts: RenderOptions = {},
): { png: Buffer; svg: string; branch: string; converged: boolean; pipeline: Pipeline } {
  const files = loadAblProjectDir(projectDir);
  const { pipeline, branch } = solveProject(files, opts);
  const errors = pipeline.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(`resolve errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  // Still render when the solver doesn't fully converge — eval needs a candidate image.
  const svg = pipelineToSvg(pipeline, opts);
  const png = svgToPng(svg, ABL_PNG_SCALE);
  return { png, svg, branch, converged: pipeline.solution.converged, pipeline };
}

/** Render from in-memory file map (e.g. DEMO_FILES). */
export function renderAblFilesToPng(
  files: Record<string, string>,
  opts: RenderOptions = {},
): { png: Buffer; svg: string; branch: string; pipeline: Pipeline } {
  const { pipeline, branch } = solveProject(files, opts);
  const svg = pipelineToSvg(pipeline, opts);
  return { png: svgToPng(svg, ABL_PNG_SCALE), svg, branch, pipeline };
}
