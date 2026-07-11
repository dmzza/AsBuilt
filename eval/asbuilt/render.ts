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
} from "../../src/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PAPER = "#f5f3ec";
const INK = "#35322b";
const DIM = "#1d4ed8";

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

function allWalls(p: Pipeline): NonNullable<ReturnType<typeof wallView>>[] {
  const out = [];
  for (const [key, eff] of p.resolved.effective) {
    if (eff.stmt.kind !== "wall") continue;
    const v = wallView(p, key);
    if (v) out.push(v);
  }
  return out;
}

export interface RenderOptions {
  /** Pixels per inch. */
  ppi?: number;
  padding?: number;
  branch?: string;
  showDims?: boolean;
  width?: number;
  height?: number;
}

export function pipelineToSvg(p: Pipeline, opts: RenderOptions = {}): string {
  const ppi = opts.ppi ?? 4;
  const pad = opts.padding ?? 48;
  const walls = allWalls(p);
  const openings = openingViews(p);
  const fixtures = fixtureViews(p);

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

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${PAPER}"/>`,
  );

  // light grid
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

  for (const w of walls) {
    const thick = 6;
    parts.push(
      `<line x1="${tx(w.a.x)}" y1="${ty(w.a.y)}" x2="${tx(w.b.x)}" y2="${ty(w.b.y)}" stroke="${INK}" stroke-width="${thick}" stroke-linecap="square"/>`,
    );
    if (opts.showDims !== false) {
      const mx = (w.a.x + w.b.x) / 2;
      const my = (w.a.y + w.b.y) / 2;
      const label = formatLength(s64FromInches(Math.round(w.lengthInches * 16) / 16));
      parts.push(
        `<text x="${tx(mx)}" y="${ty(my) - 8}" text-anchor="middle" font-size="13" font-family="ui-monospace,monospace" fill="${DIM}">${escapeXml(label)}</text>`,
      );
    }
  }

  // Junctions
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">
  ${parts.join("\n  ")}
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function svgToPng(svg: string, scale = 2): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(resvg.render().asPng());
}

export function renderAblProjectToPng(
  projectDir: string,
  opts: RenderOptions = {},
): { png: Buffer; svg: string; branch: string } {
  const files = loadAblProjectDir(projectDir);
  const project = loadProject(files);
  const branch = opts.branch ?? [...project.layers.keys()][0];
  if (!branch) throw new Error("no layers in project");
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const errors = pipeline.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(`resolve errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  // Still render when the solver doesn't fully converge — eval needs a candidate image.
  const svg = pipelineToSvg(pipeline, opts);
  const png = svgToPng(svg, 2);
  return { png, svg, branch, converged: pipeline.solution.converged };
}

/** Render from in-memory file map (e.g. DEMO_FILES). */
export function renderAblFilesToPng(
  files: Record<string, string>,
  opts: RenderOptions = {},
): { png: Buffer; svg: string; branch: string } {
  const project = loadProject(files);
  const branch = opts.branch ?? [...project.layers.keys()][0];
  if (!branch) throw new Error("no layers in project");
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const svg = pipelineToSvg(pipeline, opts);
  return { png: svgToPng(svg, 2), svg, branch };
}
