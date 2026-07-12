/**
 * Regenerate review.html from existing scorecard.json (no re-score / no API).
 *   npx vite-node scripts/regen-review-html.ts [case-dir ...]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeReviewReport } from "../eval/src/report";
import type { ScorePlanPairResult } from "../eval/src/types";

const defaults = [
  "eval/cases/demo_dining",
  "eval/cases/214_maynard_st_living_room_corrected_floorplan_3",
];
const cases = (process.argv.slice(2).length ? process.argv.slice(2) : defaults).map((p) =>
  resolve(p),
);

for (const caseDir of cases) {
  const reviews = join(caseDir, "reviews");
  if (!existsSync(reviews)) {
    console.error("skip (no reviews):", caseDir);
    continue;
  }
  const id = caseDir.split("/").pop()!;
  const dirs = readdirSync(reviews).filter((d) => existsSync(join(reviews, d, "scorecard.json")));
  for (const run of dirs) {
    const runDir = join(reviews, run);
    const sc = JSON.parse(readFileSync(join(runDir, "scorecard.json"), "utf8")) as Partial<ScorePlanPairResult> & {
      provisionalScore: ScorePlanPairResult["provisionalScore"];
      transform: ScorePlanPairResult["transform"];
    };
    const result: ScorePlanPairResult = {
      provisionalScore: sc.provisionalScore,
      findings: sc.findings ?? [],
      proposedReferenceReadings: sc.proposedReferenceReadings ?? sc.referenceDimsUsed ?? [],
      proposedCandidateReadings: sc.proposedCandidateReadings ?? sc.candidateDimsUsed ?? [],
      referenceDimsUsed: sc.referenceDimsUsed ?? [],
      candidateDimsUsed: sc.candidateDimsUsed ?? [],
      referenceStructure: sc.referenceStructure,
      candidateStructure: sc.candidateStructure,
      structureCleaned: sc.structureCleaned,
      transform: sc.transform,
      overlays: sc.overlays ?? {
        referencePng: "reference.png",
        candidatePng: "candidate.png",
        alignedCandidatePng: "aligned_candidate.png",
        onionSkinPng: "onion_skin.png",
        layoutDiffPng: "layout_diff.png",
        dimsOverlayPng: "dims_overlay.png",
      },
      notes: sc.notes ?? [],
      visionStatus: sc.visionStatus ?? {
        availability: "gold_only",
        label: "Gold only",
        summary: "Regenerated from scorecard",
        details: [],
      },
    };
    const path = writeReviewReport(runDir, result, { caseId: id });
    console.log("wrote", path);
  }
}
