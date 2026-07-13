/**
 * Regenerate aligned cleaned cand PNGs + review.html from an existing review dir.
 *
 *   npm run eval:regen-review -- eval/cases/<id>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { warpCandidateToReference } from "../eval/src/align";
import { writeReviewReport } from "../eval/src/report";
import type { ScorePlanPairResult } from "../eval/src/types";

const caseDir = process.argv[2];
if (!caseDir) {
  console.error("usage: npm run eval:regen-review -- <case-dir>");
  process.exit(2);
}

const reviewDir = join(caseDir, "reviews", "latest");
const scorecardPath = join(reviewDir, "scorecard.json");
if (!existsSync(scorecardPath)) {
  console.error(`missing ${scorecardPath}`);
  process.exit(2);
}

const sc = JSON.parse(readFileSync(scorecardPath, "utf8")) as ScorePlanPairResult & {
  overlays: ScorePlanPairResult["overlays"];
};
const reference = readFileSync(join(reviewDir, "reference.png"));
const transform = sc.transform;

async function alignIfPresent(
  srcName: string,
  outName: string,
  overlayKey: keyof ScorePlanPairResult["overlays"],
): Promise<void> {
  const srcPath = join(reviewDir, srcName);
  if (!existsSync(srcPath)) return;
  const aligned = await warpCandidateToReference(readFileSync(srcPath), reference, transform);
  writeFileSync(join(reviewDir, outName), aligned);
  sc.overlays[overlayKey] = outName;
  console.log(`  wrote ${outName} (${outName.replace("_aligned", "")} → ref frame)`);
}

await alignIfPresent("structure_cand.png", "structure_cand_aligned.png", "structureCandAlignedPng");
await alignIfPresent("dims_cand.png", "dims_cand_aligned.png", "dimsCandAlignedPng");

writeFileSync(scorecardPath, JSON.stringify(sc, null, 2) + "\n");
writeReviewReport(reviewDir, sc, { caseId: basename(caseDir) });
console.log(`  updated ${join(reviewDir, "review.html")}`);
