/** Image-space point (pixels, origin top-left). */
export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measured span on an image — endpoints are first-class. */
export interface DimSpan {
  a: Point;
  b: Point;
}

/** Optional dimension annotation graphics (vs wall strokes). */
export interface DimGraphics {
  dimLine?: { a: Point; b: Point };
  extensionA?: { a: Point; b: Point };
  extensionB?: { a: Point; b: Point };
}

/**
 * A dimension reading anchored to an image.
 * Gold requires verified value + span; no tool/ABL entity IDs.
 */
export interface DimReading {
  id: string;
  valueInches: number;
  /** Raw text as read, e.g. 13'-0" */
  valueText?: string;
  labelBBox: BBox;
  span: DimSpan;
  dimGraphics?: DimGraphics;
  confidence?: number;
  /** Competing span interpretations when wall vs dim-line is ambiguous. */
  alternateSpans?: DimSpan[];
  /** Set when a human has verified value + span. */
  verified?: boolean;
}

export type DimGold = DimReading & { verified: true };

/** Corner / T / end point on the wall structure (not a dim tick). */
export type JunctionKind = "corner" | "t" | "cross" | "end" | "unknown";

export interface Junction {
  id: string;
  point: Point;
  kind?: JunctionKind;
  confidence?: number;
  verified?: boolean;
}

/**
 * A wall segment between two structure endpoints (faces/corners).
 * Distinct from DimReading.span, which may follow dim-line graphics.
 */
export interface WallSpan {
  id: string;
  a: Point;
  b: Point;
  aJunctionId?: string;
  bJunctionId?: string;
  confidence?: number;
  verified?: boolean;
}

/** Structure layer for one image: junctions + wall spans. */
export interface StructureReading {
  junctions: Junction[];
  wallSpans: WallSpan[];
}

export type FindingKind =
  | "dim_value_mismatch"
  | "dim_span_mismatch"
  | "dim_unmatched_reference"
  | "dim_unmatched_candidate"
  | "layout_missing"
  | "layout_extra"
  | "topology"
  | "align_warning";

export type FindingStatus = "provisional" | "accepted" | "rejected";

export interface Finding {
  id: string;
  kind: FindingKind;
  message: string;
  severity: "error" | "warn" | "info";
  /** Region on reference image (if applicable). */
  referenceBBox?: BBox;
  /** Region on candidate image in candidate pixel space (pre-align). */
  candidateBBox?: BBox;
  /** Region on aligned candidate overlay (reference pixel space). */
  alignedBBox?: BBox;
  referenceDimId?: string;
  candidateDimId?: string;
  expectedInches?: number;
  actualInches?: number;
  deltaInches?: number;
  status: FindingStatus;
}

export interface SimilarityTransform {
  /** Candidate → reference: scale, rotation (radians), translation. */
  scale: number;
  rotation: number;
  tx: number;
  ty: number;
}

export interface ScoreTolerances {
  /** Max |Δ| in inches for a dim value match. Default 0.5. */
  dimInches?: number;
  /** Max endpoint distance in reference pixels for span agreement (after align). */
  spanPx?: number;
  /** Layout ink mismatch fraction before emitting a finding. */
  layoutMismatch?: number;
}

export interface ScoreAxes {
  /** 0–1 composite. */
  overall: number;
  layout: number;
  dims: number;
  /** Span association quality among paired dims. */
  spans: number;
}

export interface OverlayArtifacts {
  /** Paths relative to the run output directory. */
  referencePng: string;
  candidatePng: string;
  alignedCandidatePng: string;
  onionSkinPng: string;
  layoutDiffPng?: string;
  dimsOverlayPng?: string;
  /** Walls/windows/doors-only redraw used for structure extract (ref pixel space). */
  structureRefPng?: string;
  /** Walls/windows/doors-only redraw used for structure extract (candidate pixel space). */
  structureCandPng?: string;
  /** structure_cand warped into reference pixel grid (same frame as structure_ref). */
  structureCandAlignedPng?: string;
  /** Dimensions/measurement-lines-only redraw used for dim extract (ref pixel space). */
  dimsRefPng?: string;
  /** Dimensions/measurement-lines-only redraw used for dim extract (candidate pixel space). */
  dimsCandPng?: string;
  /** dims_cand warped into reference pixel grid (same frame as dims_ref). */
  dimsCandAlignedPng?: string;
}

export interface ScorePlanPairInput {
  reference: Buffer;
  candidate: Buffer;
  referenceGold?: DimGold[];
  candidateGold?: DimGold[];
  tolerances?: ScoreTolerances;
  /** When true (default), call vision for dims/layout if gold missing / always for layout. */
  useVision?: boolean;
  /**
   * When true (default), dim extract also runs tiled zoom passes.
   * Set false for one-shot full-image extract only.
   */
  visionTiles?: boolean;
  /** Run id / output dir for artifact paths (set by CLI). */
  artifactDir?: string;
  /**
   * Durable case directory for cleaned redraw PNGs
   * (e.g. eval/cases/<id>/cleaned/). When set, Nano Banana results are
   * cached here and reused on later runs unless EVAL_FORCE_REDRAW=1.
   */
  cleanedCacheDir?: string;
}

export interface ScorePlanPairResult {
  provisionalScore: ScoreAxes;
  findings: Finding[];
  proposedReferenceReadings: DimReading[];
  proposedCandidateReadings: DimReading[];
  referenceDimsUsed: DimReading[];
  candidateDimsUsed: DimReading[];
  /** Wall junctions + spans on the reference image (original pixel space). */
  referenceStructure?: StructureReading;
  /** Wall junctions + spans on the candidate image (candidate pixel space). */
  candidateStructure?: StructureReading;
  /** How structure redraw went for ref / cand (ok | cached | fallback | skipped). */
  structureCleaned?: {
    reference: "ok" | "cached" | "fallback" | "skipped";
    candidate: "ok" | "cached" | "fallback" | "skipped";
  };
  /** How dims redraw went for ref / cand (ok | cached | fallback | skipped). */
  dimsCleaned?: {
    reference: "ok" | "cached" | "fallback" | "skipped";
    candidate: "ok" | "cached" | "fallback" | "skipped";
  };
  transform: SimilarityTransform;
  overlays: OverlayArtifacts;
  notes: string[];
  /** Whether vision/AI was available and used for this run. */
  visionStatus: VisionStatus;
}

/** How vision/AI participated in a score run — surfaced loudly in the review UI. */
export type VisionAvailability =
  | "used"
  | "gold_only"
  | "missing_key"
  | "disabled"
  | "failed"
  | "partial";

export interface VisionStatus {
  availability: VisionAvailability;
  /** Short pill label, e.g. "No API key". */
  label: string;
  /** One-line explanation for banners. */
  summary: string;
  provider?: string;
  model?: string;
  details: string[];
}

export interface CaseMeta {
  branch?: string;
  /** If set, render this project dir to candidate.png before scoring. */
  asbuiltProject?: string;
  tolerances?: ScoreTolerances;
  title?: string;
  /**
   * When false, dim vision extract is one-shot full-page only (no tiled crops).
   * Default true.
   */
  visionTiles?: boolean;
}

export interface ReviewDecision {
  findingId?: string;
  dimId?: string;
  action: "accept" | "reject" | "correct";
  /** For correct: patched dim fields. */
  dimPatch?: Partial<DimReading>;
  note?: string;
  at: string;
}
