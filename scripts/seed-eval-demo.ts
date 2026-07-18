/**
 * Seed eval/cases/demo_dining from the in-repo demo project.
 * Creates reference + candidate PNGs and image-anchored gold from solved
 * measured dims (so dim matching works without a vision API key).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_FILES } from "../src/demo";
import { deriveAblEvalLayersFromFiles } from "../eval/asbuilt/serialize";
import { saveDimGold } from "../eval/src/gold";
import sharp from "sharp";

const caseDir = join("eval/cases/demo_dining");
const projectDir = join(caseDir, "project");
const ppi = 5;

mkdirSync(join(projectDir, "concepts"), { recursive: true });
writeFileSync(join(projectDir, "asbuilt.abl"), DEMO_FILES["asbuilt.abl"]!);
writeFileSync(join(projectDir, "concepts/galley.abl"), DEMO_FILES["concepts/galley.abl"]!);

const layers = deriveAblEvalLayersFromFiles(DEMO_FILES, {
  branch: "asbuilt",
  ppi,
  showDims: true,
});
writeFileSync(join(caseDir, "candidate.png"), layers.fullPng);

const reference = await sharp(layers.fullPng)
  .modulate({ brightness: 1.02, saturation: 0.85 })
  .sharpen({ sigma: 0.8 })
  .png()
  .toBuffer();
writeFileSync(join(caseDir, "reference.png"), reference);

mkdirSync(join(caseDir, "gold"), { recursive: true });
saveDimGold(join(caseDir, "gold/reference.dims.json"), layers.dims);
// Candidate is the same geometry in this seed — same gold (demonstrates match).
saveDimGold(join(caseDir, "gold/candidate.dims.json"), layers.dims);

writeFileSync(
  join(caseDir, "meta.json"),
  JSON.stringify(
    {
      title: "Demo dining + kitchen (seed)",
      branch: "asbuilt",
      asbuiltProject: "project",
      tolerances: { dimInches: 0.5, spanPx: 48, layoutMismatch: 0.35 },
      notes:
        "Seed gold was derived from solved measured dims in image space (for pipeline smoke). Replace reference.png with a real hand-drawing scan and re-verify spans in the review UI.",
    },
    null,
    2,
  ) + "\n",
);

console.log(`Seeded ${caseDir}`);
console.log(`  reference.png, candidate.png, project/, meta.json`);
console.log(`  gold: ${layers.dims.length} verified dim(s) on reference + candidate`);
