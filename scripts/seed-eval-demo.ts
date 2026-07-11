/**
 * Seed eval/cases/demo_dining from the in-repo demo project.
 * Creates reference + candidate PNGs, optional image-anchored gold from solved walls
 * (so dim matching works without a vision API key).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_FILES } from "../src/demo";
import {
  renderAblFilesToPng,
  pipelineToSvg,
  svgToPng,
} from "../eval/asbuilt/render";
import {
  formatLength,
  layerMap,
  loadProject,
  resolveAndSolve,
  s64FromInches,
  wallView,
} from "../src/core";
import { saveDimGold } from "../eval/src/gold";
import type { DimGold } from "../eval/src/types";
import sharp from "sharp";

const caseDir = join("eval/cases/demo_dining");
const projectDir = join(caseDir, "project");
const ppi = 5;
const pad = 48;

mkdirSync(join(projectDir, "concepts"), { recursive: true });
writeFileSync(join(projectDir, "asbuilt.abl"), DEMO_FILES["asbuilt.abl"]!);
writeFileSync(join(projectDir, "concepts/galley.abl"), DEMO_FILES["concepts/galley.abl"]!);

const clean = renderAblFilesToPng(DEMO_FILES, { branch: "asbuilt", ppi, showDims: true });
writeFileSync(join(caseDir, "candidate.png"), clean.png);

const project = loadProject(DEMO_FILES);
const pipeline = resolveAndSolve(layerMap(project), "asbuilt");
const svg = pipelineToSvg(pipeline, { ppi, showDims: true });
const roughPng = svgToPng(svg, 2);
const reference = await sharp(roughPng)
  .modulate({ brightness: 1.02, saturation: 0.85 })
  .sharpen({ sigma: 0.8 })
  .png()
  .toBuffer();
writeFileSync(join(caseDir, "reference.png"), reference);

// Build image-anchored gold from measured wall lengths (pixel spans).
// SVG is rendered at ppi, then rasterized at scale 2 by resvg.
const scale = 2;
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
const walls = [];
for (const [key, eff] of pipeline.resolved.effective) {
  if (eff.stmt.kind !== "wall") continue;
  const v = wallView(pipeline, key);
  if (!v) continue;
  walls.push(v);
  minX = Math.min(minX, v.a.x, v.b.x);
  minY = Math.min(minY, v.a.y, v.b.y);
  maxX = Math.max(maxX, v.a.x, v.b.x);
  maxY = Math.max(maxY, v.a.y, v.b.y);
}

const tx = (x: number) => (pad + (x - minX) * ppi) * scale;
const ty = (y: number) => (pad + (maxY - y) * ppi) * scale;

const measuredNames = new Set([
  "dl.west",
  "dl.north",
  "dl.east",
  "dl.south",
  "k.west",
  "k.east",
  "k.north",
  "k.south",
]);

const dims: DimGold[] = [];
let i = 0;
for (const w of walls) {
  // Prefer exterior / named spans that appear as callouts
  if (!measuredNames.has(w.name) && !w.name.startsWith("k.")) continue;
  i++;
  const ax = tx(w.a.x);
  const ay = ty(w.a.y);
  const bx = tx(w.b.x);
  const by = ty(w.b.y);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const label = formatLength(s64FromInches(Math.round(w.lengthInches * 16) / 16));
  dims.push({
    id: `dim-${i}`,
    valueInches: w.lengthInches,
    valueText: label,
    labelBBox: { x: mx - 30, y: my - 24, w: 60, h: 18 },
    span: { a: { x: ax, y: ay }, b: { x: bx, y: by } },
    verified: true,
    confidence: 1,
  });
}

mkdirSync(join(caseDir, "gold"), { recursive: true });
saveDimGold(join(caseDir, "gold/reference.dims.json"), dims);
// Candidate is the same geometry in this seed — same gold (demonstrates match).
saveDimGold(join(caseDir, "gold/candidate.dims.json"), dims);

writeFileSync(
  join(caseDir, "meta.json"),
  JSON.stringify(
    {
      title: "Demo dining + kitchen (seed)",
      branch: "asbuilt",
      asbuiltProject: "project",
      tolerances: { dimInches: 0.5, spanPx: 48, layoutMismatch: 0.35 },
      notes:
        "Seed gold was derived from solved wall endpoints in image space (for pipeline smoke). Replace reference.png with a real hand-drawing scan and re-verify spans in the review UI.",
    },
    null,
    2,
  ) + "\n",
);

console.log(`Seeded ${caseDir}`);
console.log(`  reference.png, candidate.png, project/, meta.json`);
console.log(`  gold: ${dims.length} verified dim(s) on reference + candidate`);
