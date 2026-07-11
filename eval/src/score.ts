import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateSimilarityTransform,
  onionSkin,
  warpCandidateToReference,
} from "./align";
import { extractDimensions, visionTopologyFindings } from "./dims/extract";
import { matchDimensions } from "./dims/match";
import { compareLayout } from "./layout";
import { drawDimsOverlay } from "./overlay";
import { deriveVisionStatus } from "./vision/status";
import type {
  DimGold,
  DimReading,
  ScoreAxes,
  ScorePlanPairInput,
  ScorePlanPairResult,
} from "./types";

function asUsed(gold: DimGold[] | undefined, proposed: DimReading[]): DimReading[] {
  if (gold && gold.length > 0) return gold;
  return proposed;
}

/**
 * Tool-agnostic plan fidelity score: reference image vs candidate image.
 * No AsBuilt types. Gold dims are optional image-anchored verified readings.
 */
export async function scorePlanPair(
  input: ScorePlanPairInput,
): Promise<ScorePlanPairResult> {
  const notes: string[] = [];
  const useVision = input.useVision !== false;
  const artifactDir = input.artifactDir;

  const transform = await estimateSimilarityTransform(input.reference, input.candidate);
  notes.push(
    `Align: scale=${transform.scale.toFixed(4)} rot=${((transform.rotation * 180) / Math.PI).toFixed(2)}°`,
  );

  const aligned = await warpCandidateToReference(input.candidate, input.reference, transform);
  const onion = await onionSkin(input.reference, aligned);

  const layout = await compareLayout(
    input.reference,
    aligned,
    input.tolerances?.layoutMismatch ?? 0.35,
  );

  let proposedReferenceReadings: DimReading[] = [];
  let proposedCandidateReadings: DimReading[] = [];

  if (useVision) {
    if (!input.referenceGold?.length) {
      const ex = await extractDimensions(input.reference);
      proposedReferenceReadings = ex.readings;
      notes.push(...ex.notes.map((n) => `ref: ${n}`));
    } else {
      notes.push(`Using ${input.referenceGold.length} verified reference gold dim(s)`);
    }
    if (!input.candidateGold?.length) {
      const ex = await extractDimensions(input.candidate);
      proposedCandidateReadings = ex.readings;
      notes.push(...ex.notes.map((n) => `cand: ${n}`));
    } else {
      notes.push(`Using ${input.candidateGold.length} verified candidate gold dim(s)`);
    }
  } else {
    notes.push("Vision disabled (useVision=false)");
  }

  const referenceDimsUsed = asUsed(input.referenceGold, proposedReferenceReadings);
  const candidateDimsUsed = asUsed(input.candidateGold, proposedCandidateReadings);

  const dimMatch = matchDimensions(
    referenceDimsUsed,
    candidateDimsUsed,
    transform,
    input.tolerances,
  );

  let topoFindings = { findings: [] as ScorePlanPairResult["findings"], notes: [] as string[] };
  if (useVision) {
    topoFindings = await visionTopologyFindings(input.reference, aligned);
    notes.push(...topoFindings.notes);
  }

  const findings = [
    ...layout.findings,
    ...dimMatch.findings,
    ...topoFindings.findings,
  ];

  if (transform.scale < 0.15 || transform.scale > 8) {
    findings.unshift({
      id: "align-warning-scale",
      kind: "align_warning",
      message: `Suspicious alignment scale ${transform.scale.toFixed(3)} — review onion skin`,
      severity: "warn",
      status: "provisional",
    });
  }
  const rotDeg = Math.abs((transform.rotation * 180) / Math.PI);
  const nearOrtho = [0, 90, 180].some((d) => Math.abs(rotDeg - d) < 3);
  if (rotDeg > 5 && !nearOrtho) {
    findings.unshift({
      id: "align-warning-rotation",
      kind: "align_warning",
      message: `Non-orthogonal alignment rotation ${((transform.rotation * 180) / Math.PI).toFixed(1)}° — review onion skin`,
      severity: "warn",
      status: "provisional",
    });
  }

  const hasDims = referenceDimsUsed.length > 0;
  if (!hasDims) {
    notes.push("No reference dimensions available — overall reflects layout only");
  }

  const visionStatus = deriveVisionStatus({
    notes,
    referenceDimCount: referenceDimsUsed.length,
    candidateDimCount: candidateDimsUsed.length,
    usedReferenceGold: Boolean(input.referenceGold?.length),
    usedCandidateGold: Boolean(input.candidateGold?.length),
  });

  const axes: ScoreAxes = {
    layout: layout.score,
    dims: dimMatch.valueScore,
    spans: dimMatch.spanScore,
    overall: hasDims
      ? 0.35 * layout.score + 0.4 * dimMatch.valueScore + 0.25 * dimMatch.spanScore
      : layout.score,
  };

  const overlays = {
    referencePng: "reference.png",
    candidatePng: "candidate.png",
    alignedCandidatePng: "aligned_candidate.png",
    onionSkinPng: "onion_skin.png",
    layoutDiffPng: "layout_diff.png",
    dimsOverlayPng: "dims_overlay.png",
  };

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, overlays.referencePng), input.reference);
    writeFileSync(join(artifactDir, overlays.candidatePng), input.candidate);
    writeFileSync(join(artifactDir, overlays.alignedCandidatePng), aligned);
    writeFileSync(join(artifactDir, overlays.onionSkinPng), onion);
    writeFileSync(join(artifactDir, overlays.layoutDiffPng!), layout.diffPng);

    // Dim overlay on onion skin in reference space (ref dims + aligned cand spans drawn via findings)
    const overlay = await drawDimsOverlay(onion, referenceDimsUsed, findings, {
      title: "Dims + findings (reference gold/proposed spans)",
    });
    writeFileSync(join(artifactDir, overlays.dimsOverlayPng!), overlay);

    writeFileSync(
      join(artifactDir, "scorecard.json"),
      JSON.stringify(
        {
          provisionalScore: axes,
          findings,
          transform,
          notes,
          visionStatus,
          referenceDimsUsed,
          candidateDimsUsed,
          proposedReferenceReadings,
          proposedCandidateReadings,
          overlays,
        },
        null,
        2,
      ) + "\n",
    );
  }

  return {
    provisionalScore: axes,
    findings,
    proposedReferenceReadings,
    proposedCandidateReadings,
    referenceDimsUsed,
    candidateDimsUsed,
    transform,
    overlays,
    notes,
    visionStatus,
  };
}
