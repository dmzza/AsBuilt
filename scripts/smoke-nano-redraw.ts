/**
 * Smoke: Nano Banana structure + dims redraw on Maynard _4 reference.
 *   npx vite-node scripts/smoke-nano-redraw.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  redrawDimsClean,
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

const structure = await redrawStructureClean(ref);
console.log(
  "structure:",
  JSON.stringify(
    {
      status: structure.status,
      notes: structure.notes,
      model: structure.model,
      bytes: structure.cleanedPng?.length ?? 0,
    },
    null,
    2,
  ),
);

const dims = await redrawDimsClean(ref);
console.log(
  "dims:",
  JSON.stringify(
    {
      status: dims.status,
      notes: dims.notes,
      model: dims.model,
      bytes: dims.cleanedPng?.length ?? 0,
    },
    null,
    2,
  ),
);

const outDir = join(caseDir, "reviews", "latest");
mkdirSync(outDir, { recursive: true });

let ok = 0;
if (structure.cleanedPng) {
  const path = join(outDir, "structure_ref_nano_smoke.png");
  writeFileSync(path, structure.cleanedPng);
  console.log("wrote", path);
  ok++;
}
if (dims.cleanedPng) {
  const path = join(outDir, "dims_ref_nano_smoke.png");
  writeFileSync(path, dims.cleanedPng);
  console.log("wrote", path);
  ok++;
}

if (ok === 2) process.exit(0);
if (structure.status === "skipped" && dims.status === "skipped") process.exit(2);
process.exit(1);
