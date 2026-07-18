import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateSimilarityTransform,
  onionSkin,
  refineTransformFromDims,
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
  SimilarityTransform,
  StructureReading,
} from "./types";

function asUsed(gold: DimGold[] | undefined, proposed: DimReading[]): DimReading[] {
  if (gold && gold.length > 0) return gold;
  return proposed;
}

/**
 * Tool-agnostic plan fidelity score: reference image vs candidate image.
 * No AsBuilt types. Gold dims / structure overrides skip AI for that side.
 */
export async function scorePlanPair(
  input: ScorePlanPairInput,
): Promise<ScorePlanPairResult> {
  const notes: string[] = [];
  const useVision = input.useVision !== false;
  const artifactDir = input.artifactDir;

  // 1) Ink/bbox seed align (may be wrong scale for clean ABL renders vs sketches).
  let transform: SimilarityTransform = await estimateSimilarityTransform(
    input.reference,
    input.candidate,
  );
  notes.push(
    `Align: scale=${transform.scale.toFixed(4)} rot=${((transform.rotation * 180) / Math.PI).toFixed(2)}° (ink)`,
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

  const cleanedDir = input.cleanedCacheDir;
  const tiles = input.visionTiles !== false;
  if (useVision && !tiles) {
    notes.push("Vision dim extract: one-shot full-page only (tiles disabled)");
  }

  // 2) Structure + dims first (image-space; no align needed).
  if (input.referenceStructure) {
    referenceStructure = input.referenceStructure;
    structureRefCleaned = input.referenceStructurePng ?? null;
    structureCleaned.reference = "skipped";
    notes.push("ref-structure: derived from .abl (skipped AI)");
  } else if (useVision) {
    const sx = await extractStructure(input.reference, {
      cleanedCachePath: cleanedDir ? join(cleanedDir, "structure_ref.png") : undefined,
    });
    referenceStructure = sx.structure;
    structureRefCleaned = sx.cleanedPng;
    structureCleaned.reference = sx.cleanedStatus;
    notes.push(...sx.notes.map((n) => `ref-structure: ${n}`));
  }

  if (input.candidateStructure) {
    candidateStructure = input.candidateStructure;
    structureCandCleaned = input.candidateStructurePng ?? null;
    structureCleaned.candidate = "skipped";
    notes.push("cand-structure: derived from .abl (skipped AI)");
  } else if (useVision) {
    const sx = await extractStructure(input.candidate, {
      cleanedCachePath: cleanedDir ? join(cleanedDir, "structure_cand.png") : undefined,
    });
    candidateStructure = sx.structure;
    structureCandCleaned = sx.cleanedPng;
    structureCleaned.candidate = sx.cleanedStatus;
    notes.push(...sx.notes.map((n) => `cand-structure: ${n}`));
  }

  if (input.referenceGold?.length) {
    notes.push(`Using ${input.referenceGold.length} verified reference gold dim(s)`);
    dimsRefCleaned = input.referenceDimsPng ?? null;
    if (input.referenceDimsPng) {
      dimsCleaned.reference = "skipped";
      notes.push("ref-dims: layer PNG from .abl (skipped AI redraw)");
    }
  } else if (useVision) {
    const ex = await extractDimensions(input.reference, {
      tiles,
      cleanedCachePath: cleanedDir ? join(cleanedDir, "dims_ref.png") : undefined,
    });
    proposedReferenceReadings = ex.readings;
    dimsRefCleaned = ex.cleanedPng;
    dimsCleaned.reference = ex.cleanedStatus;
    notes.push(...ex.notes.map((n) => `ref: ${n}`));
  }

  if (input.candidateGold?.length) {
    notes.push(`Using ${input.candidateGold.length} verified candidate gold dim(s)`);
    dimsCandCleaned = input.candidateDimsPng ?? null;
    if (input.candidateDimsPng) {
      dimsCleaned.candidate = "skipped";
      notes.push("cand-dims: layer PNG from .abl (skipped AI redraw)");
    }
  } else if (useVision) {
    const ex = await extractDimensions(input.candidate, {
      tiles,
      cleanedCachePath: cleanedDir ? join(cleanedDir, "dims_cand.png") : undefined,
    });
    proposedCandidateReadings = ex.readings;
    dimsCandCleaned = ex.cleanedPng;
    dimsCleaned.candidate = ex.cleanedStatus;
    notes.push(...ex.notes.map((n) => `cand: ${n}`));
  }

  if (!useVision) {
    notes.push("Vision disabled (useVision=false)");
  }

  const referenceDimsUsed = asUsed(input.referenceGold, proposedReferenceReadings);
  const candidateDimsUsed = asUsed(input.candidateGold, proposedCandidateReadings);

  // 3) Refine scale/translation from value-matched dim spans when possible.
  const refined = refineTransformFromDims(
    referenceDimsUsed,
    candidateDimsUsed,
    transform,
    { dimTolInches: input.tolerances?.dimInches },
  );
  notes.push(...refined.notes);
  transform = refined.transform;

  // 4) Warp / layout / match with final transform.
  const aligned = await warpCandidateToReference(input.candidate, input.reference, transform);
  const onion = await onionSkin(input.reference, aligned);

  // Prefer walls-only structure layers for layout — full Original PNGs include
  // grids, dim labels, fixtures, and sketch clutter that aren't layout.
  let structureCandAligned: Buffer | null = null;
  if (structureCandCleaned) {
    structureCandAligned = await warpCandidateToReference(
      structureCandCleaned,
      input.reference,
      transform,
    );
  }
  const useStructureLayout = Boolean(structureRefCleaned && structureCandAligned);
  const layout = await compareLayout(
    useStructureLayout ? structureRefCleaned! : input.reference,
    useStructureLayout ? structureCandAligned! : aligned,
    input.tolerances?.layoutMismatch ?? 0.35,
  );
  notes.push(
    useStructureLayout
      ? "Layout compare: structure_ref vs structure_cand_aligned (walls-only)"
      : "Layout compare: Original reference vs aligned candidate (structure layers unavailable)",
  );

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
  if (structureCandAligned) overlays.structureCandAlignedPng = "structure_cand_aligned.png";
  if (dimsRefCleaned) overlays.dimsRefPng = "dims_ref.png";
  if (dimsCandCleaned) overlays.dimsCandPng = "dims_cand.png";

  let dimsCandAligned: Buffer | null = null;
  if (dimsCandCleaned) {
    dimsCandAligned = await warpCandidateToReference(
      dimsCandCleaned,
      input.reference,
      transform,
    );
    overlays.dimsCandAlignedPng = "dims_cand_aligned.png";
  }

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
    if (structureCandAligned && overlays.structureCandAlignedPng) {
      writeFileSync(join(artifactDir, overlays.structureCandAlignedPng), structureCandAligned);
    }
    if (dimsRefCleaned && overlays.dimsRefPng) {
      writeFileSync(join(artifactDir, overlays.dimsRefPng), dimsRefCleaned);
    }
    if (dimsCandCleaned && overlays.dimsCandPng) {
      writeFileSync(join(artifactDir, overlays.dimsCandPng), dimsCandCleaned);
    }
    if (dimsCandAligned && overlays.dimsCandAlignedPng) {
      writeFileSync(join(artifactDir, overlays.dimsCandAlignedPng), dimsCandAligned);
    }

    if (input.cleanedCacheDir) {
      if (structureCandAligned && overlays.structureCandAlignedPng) {
        writeFileSync(
          join(input.cleanedCacheDir, overlays.structureCandAlignedPng),
          structureCandAligned,
        );
      }
      if (dimsCandAligned && overlays.dimsCandAlignedPng) {
        writeFileSync(
          join(input.cleanedCacheDir, overlays.dimsCandAlignedPng),
          dimsCandAligned,
        );
      }
      // Only cache vision-extracted layers, not ABL-derived overrides.
      // ABL-derived layers would clobber extract artifacts from sketch workflows.
      if (structureRefCleaned && overlays.structureRefPng && !input.referenceStructure) {
        writeFileSync(join(input.cleanedCacheDir, overlays.structureRefPng), structureRefCleaned);
      }
      if (structureCandCleaned && overlays.structureCandPng && !input.candidateStructure) {
        writeFileSync(join(input.cleanedCacheDir, overlays.structureCandPng), structureCandCleaned);
      }
      if (dimsRefCleaned && overlays.dimsRefPng && !input.referenceGold) {
        writeFileSync(join(input.cleanedCacheDir, overlays.dimsRefPng), dimsRefCleaned);
      }
      if (dimsCandCleaned && overlays.dimsCandPng && !input.candidateGold) {
        writeFileSync(join(input.cleanedCacheDir, overlays.dimsCandPng), dimsCandCleaned);
      }
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
