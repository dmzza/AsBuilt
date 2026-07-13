/**
 * Build-time: regenerate review.html for the Pages preview fixture so every
 * deploy reflects the current branch's eval/src/report.ts.
 *
 * Fixture assets (scorecard + PNGs) live under public/eval-review/<case>/.
 * Vite copies public/ → dist/; this script writes review.html beside them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeReviewReport } from "../eval/src/report";
import type { ScorePlanPairResult } from "../eval/src/types";

const root = resolve("public/eval-review");
if (!existsSync(root)) {
  console.log("prepare-eval-preview: no public/eval-review — skip");
  process.exit(0);
}

for (const id of readdirSync(root)) {
  const dir = join(root, id);
  if (!statSync(dir).isDirectory()) continue;
  const scorePath = join(dir, "scorecard.json");
  if (!existsSync(scorePath)) {
    console.warn(`prepare-eval-preview: skip ${id} (no scorecard.json)`);
    continue;
  }
  const sc = JSON.parse(readFileSync(scorePath, "utf8")) as Partial<ScorePlanPairResult> & {
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
    dimsCleaned: sc.dimsCleaned,
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
      summary: "Static Pages preview fixture",
      details: [],
    },
  };
  const path = writeReviewReport(dir, result, { caseId: id });
  console.log("prepare-eval-preview:", path);
}
