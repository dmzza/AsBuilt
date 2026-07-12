/**
 * Smoke: Nano Banana structure redraw on Maynard _4 reference only.
 *   npx vite-node scripts/smoke-nano-redraw.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  redrawStructureClean,
  resolveGeminiApiKey,
  resolveNanoBananaModel,
} from "../eval/src/structure/redraw";

const caseDir = resolve(
  "eval/cases/214_maynard_st_living_room_corrected_floorplan_4",
);
const ref = readFileSync(join(caseDir, "reference.png"));

console.log("apiKey:", resolveGeminiApiKey() ? "present" : "MISSING");
console.log("model:", resolveNanoBananaModel());

const r = await redrawStructureClean(ref);
console.log(
  JSON.stringify(
    {
      status: r.status,
      notes: r.notes,
      model: r.model,
      bytes: r.cleanedPng?.length ?? 0,
    },
    null,
    2,
  ),
);

if (r.cleanedPng) {
  const outDir = join(caseDir, "reviews", "latest");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "structure_ref_nano_smoke.png");
  writeFileSync(path, r.cleanedPng);
  console.log("wrote", path);
  process.exit(0);
}

process.exit(r.status === "skipped" ? 2 : 1);
