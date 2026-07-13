/**
 * ABL authoring prep: redraw + extract for a single reference sketch (no candidate).
 *
 *   npm run eval:extract -- path/to/sketch.png
 *   npm run eval:extract -- eval/cases/my_case
 *   npm run eval:extract -- path/to/sketch.png --out eval/cases/my_case
 *   EVAL_FORCE_REDRAW=1 npm run eval:extract -- ...
 *   npm run eval:extract -- --help
 *
 * Env (same as full eval): GEMINI_API_KEY, EVAL_FORCE_REDRAW, EVAL_VISION_MODEL,
 * EVAL_IMAGE_REDRAW_MODEL / GEMINI_IMAGE_MODEL.
 */
import { resolve } from "node:path";
import { extractReferenceCase } from "../eval/src/extractCase";

function printHelp(): void {
  console.log(`ABL authoring prep — single-reference structure/dims extract

Usage:
  npm run eval:extract -- <image-or-case-dir> [options]

Examples:
  npm run eval:extract -- path/to/sketch.png
  npm run eval:extract -- eval/cases/my_case
  npm run eval:extract -- path/to/sketch.png --out eval/cases/my_case
  EVAL_FORCE_REDRAW=1 npm run eval:extract -- eval/cases/my_case
  npm run eval:extract -- sketch.png --no-tiles

Options:
  --out <dir>     Case directory when input is a bare image (default: eval/cases/<slug>)
  --no-tiles      One-shot dim extract only (skip tiled zoom passes)
  --help, -h      Show this help

Artifacts written under the case dir:
  cleaned/structure_ref.png   walls/windows/doors-only redraw
  cleaned/dims_ref.png        dimensions/measurement-lines-only redraw
  extract/structure_ref.json  junctions + wallSpans
  extract/dims_ref.json       dimensions (valueInches, span, labelBBox)
  extract/summary.md          counts + how to use
  reviews/extract/review.html minimal single-image review UI

Then author .abl and score:
  npm run eval -- eval/cases/<id>
`);
}

const raw = process.argv.slice(2).filter((a) => a !== "--");
if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
  printHelp();
  process.exit(raw.length === 0 ? 2 : 0);
}

const outIdx = raw.indexOf("--out");
let outDir: string | undefined;
const args = [...raw];
if (outIdx >= 0) {
  const v = args[outIdx + 1];
  if (!v || v.startsWith("-")) {
    console.error("--out requires a directory path");
    process.exit(2);
  }
  outDir = resolve(v);
  args.splice(outIdx, 2);
}

const noTiles = args.includes("--no-tiles");
const positional = args.filter((a) => a !== "--no-tiles");
const input = positional[0];
if (!input || positional.length > 1) {
  console.error("usage: npm run eval:extract -- <image-or-case-dir> [--out dir] [--no-tiles]");
  process.exit(2);
}

const result = await extractReferenceCase({
  input: resolve(input),
  outDir,
  visionTiles: noTiles ? false : undefined,
});

console.log(`\n── extract: ${result.caseId}`);
if (result.createdCase) console.log(`  created case ${result.caseDir}`);
else console.log(`  case ${result.caseDir}`);
console.log(
  `  structure junctions=${result.structure.junctions.length} walls=${result.structure.wallSpans.length} (${result.structureCleaned})`,
);
console.log(
  `  dims ${result.dimensions.length} reading(s) (${result.dimsCleaned})`,
);
console.log(`  vision: ${result.visionStatus.label} — ${result.visionStatus.summary}`);
for (const n of result.notes) console.log(`  note  ${n}`);
console.log(`\n  extract/structure_ref.json`);
console.log(`  extract/dims_ref.json`);
console.log(`  extract/summary.md`);
console.log(`  review  ${result.artifacts.reviewHtml}`);
console.log(`\nDone. Author .abl, then: npm run eval -- ${result.caseDir}`);
