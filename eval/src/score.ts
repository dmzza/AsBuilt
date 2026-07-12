import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateSimilarityTransform,
  onionSkin,
  warpCandidateToReference,
} from "./align";
import { extractDimensions, visionTopologyFindings } from "./dims/extract";
import { extractStructure } from "./structure/extract";
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
  StructureReading,
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
  let referenceStructure: StructureReading = { junctions: [], wallSpans: [] };
  let candidateStructure: StructureReading = { junctions: [], wallSpans: [] };
  let structureRefCleaned: Buffer | null = null;
  let structureCandCleaned: Buffer | null = null;
  let structureCleaned: ScorePlanPairResult["structureCleaned"] = {
    reference: "skipped",
    candidate: "skipped",
  };
  let dimsRefCleaned: Buffer | null = null;
  let dimsCandCleaned: Buffer | null = null;
  let dimsCleaned: ScorePlanPairResult["dimsCleaned"] = {
    reference: "skipped",
    candidate: "skipped",
  };

  if (useVision) {
    const extractOpts = { tiles: input.visionTiles !== false };
    if (input.visionTiles === false) {
      notes.push("Vision dim extract: one-shot full-page only (tiles disabled)");
    }

    // Structure layer (walls/junctions) — Nano Banana walls-only redraw, then extract.
    {
      const sx = await extractStructure(input.reference);
      referenceStructure = sx.structure;
      structureRefCleaned = sx.cleanedPng;
      structureCleaned.reference = sx.cleanedStatus;
      notes.push(...sx.notes.map((n) => `ref-structure: ${n}`));
    }
    {
      const sx = await extractStructure(input.candidate);
      candidateStructure = sx.structure;
      structureCandCleaned = sx.cleanedPng;
      structureCleaned.candidate = sx.cleanedStatus;
      notes.push(...sx.notes.map((n) => `cand-structure: ${n}`));
    }

    // Dim layer — Nano Banana dims-only redraw, then extract (layout/align stay on originals).
    if (!input.referenceGold?.length) {
      const ex = await extractDimensions(input.reference, extractOpts);
      proposedReferenceReadings = ex.readings;
      dimsRefCleaned = ex.cleanedPng;
      dimsCleaned.reference = ex.cleanedStatus;
      notes.push(...ex.notes.map((n) => `ref: ${n}`));
    } else {
      notes.push(`Using ${input.referenceGold.length} verified reference gold dim(s)`);
    }
    if (!input.candidateGold?.length) {
      const ex = await extractDimensions(input.candidate, extractOpts);
      proposedCandidateReadings = ex.readings;
      dimsCandCleaned = ex.cleanedPng;
      dimsCleaned.candidate = ex.cleanedStatus;
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

  const overlays: ScorePlanPairResult["overlays"] = {
    referencePng: "reference.png",
    candidatePng: "candidate.png",
    alignedCandidatePng: "aligned_candidate.png",
    onionSkinPng: "onion_skin.png",
    layoutDiffPng: "layout_diff.png",
    dimsOverlayPng: "dims_overlay.png",
  };
  if (structureRefCleaned) overlays.structureRefPng = "structure_ref.png";
  if (structureCandCleaned) overlays.structureCandPng = "structure_cand.png";
  if (dimsRefCleaned) overlays.dimsRefPng = "dims_ref.png";
  if (dimsCandCleaned) overlays.dimsCandPng = "dims_cand.png";

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, overlays.referencePng), input.reference);
    writeFileSync(join(artifactDir, overlays.candidatePng), input.candidate);
    writeFileSync(join(artifactDir, overlays.alignedCandidatePng), aligned);
    writeFileSync(join(artifactDir, overlays.onionSkinPng), onion);
    writeFileSync(join(artifactDir, overlays.layoutDiffPng!), layout.diffPng);
    if (structureRefCleaned && overlays.structureRefPng) {
      writeFileSync(join(artifactDir, overlays.structureRefPng), structureRefCleaned);
    }
    if (structureCandCleaned && overlays.structureCandPng) {
      writeFileSync(join(artifactDir, overlays.structureCandPng), structureCandCleaned);
    }
    if (dimsRefCleaned && overlays.dimsRefPng) {
      writeFileSync(join(artifactDir, overlays.dimsRefPng), dimsRefCleaned);
    }
    if (dimsCandCleaned && overlays.dimsCandPng) {
      writeFileSync(join(artifactDir, overlays.dimsCandPng), dimsCandCleaned);
    }

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
          referenceStructure,
          candidateStructure,
          structureCleaned,
          dimsCleaned,
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
    referenceStructure,
    candidateStructure,
    structureCleaned,
    dimsCleaned,
    transform,
    overlays,
    notes,
    visionStatus,
  };
}
