import { applyTransform } from "../align";
import { dist, mid, spanBBox } from "../image";
import type {
  DimReading,
  Finding,
  ScoreTolerances,
  SimilarityTransform,
} from "../types";

export interface DimMatchResult {
  findings: Finding[];
  /** 0–1 fraction of reference dims matched within value tolerance. */
  valueScore: number;
  /** 0–1 fraction of matched pairs whose spans agree. */
  spanScore: number;
}

function spanMid(r: DimReading) {
  return mid(r.span.a, r.span.b);
}

function spanLenPx(r: DimReading) {
  return dist(r.span.a, r.span.b);
}

/**
 * Pair reference dims to candidate dims in aligned (reference) space.
 * Candidate readings are transformed with `transform` (candidate→reference).
 */
export function matchDimensions(
  reference: DimReading[],
  candidate: DimReading[],
  transform: SimilarityTransform,
  tolerances?: ScoreTolerances,
): DimMatchResult {
  const dimTol = tolerances?.dimInches ?? 0.5;
  const spanTol = tolerances?.spanPx ?? 48;
  const findings: Finding[] = [];

  const candAligned = candidate.map((c) => ({
    reading: c,
    mid: applyTransform(spanMid(c), transform),
    a: applyTransform(c.span.a, transform),
    b: applyTransform(c.span.b, transform),
  }));

  const usedCand = new Set<string>();
  let valueHits = 0;
  let spanHits = 0;
  let pairs = 0;

  for (const ref of reference) {
    const rm = spanMid(ref);
    let best: (typeof candAligned)[0] | null = null;
    let bestDist = Infinity;
    for (const c of candAligned) {
      if (usedCand.has(c.reading.id)) continue;
      // Prefer candidates with similar value, then proximity
      const valuePenalty = Math.abs(c.reading.valueInches - ref.valueInches) * 2;
      const d = dist(rm, c.mid) + valuePenalty;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }

    if (!best || bestDist > 400) {
      findings.push({
        id: `dim-unmatched-ref-${ref.id}`,
        kind: "dim_unmatched_reference",
        message: `Reference dim ${ref.valueText ?? ref.valueInches + '"'} has no nearby candidate match`,
        severity: "error",
        referenceBBox: spanBBox(ref.span.a, ref.span.b),
        referenceDimId: ref.id,
        expectedInches: ref.valueInches,
        status: "provisional",
      });
      continue;
    }

    usedCand.add(best.reading.id);
    pairs++;
    const delta = Math.abs(best.reading.valueInches - ref.valueInches);
    const valueOk = delta <= dimTol;
    if (valueOk) valueHits++;
    else {
      findings.push({
        id: `dim-value-${ref.id}-${best.reading.id}`,
        kind: "dim_value_mismatch",
        message: `Dim value mismatch: reference ${ref.valueText ?? ref.valueInches}" vs candidate ${best.reading.valueText ?? best.reading.valueInches}" (Δ ${delta.toFixed(2)}")`,
        severity: "error",
        referenceBBox: { ...ref.labelBBox },
        candidateBBox: { ...best.reading.labelBBox },
        alignedBBox: spanBBox(best.a, best.b),
        referenceDimId: ref.id,
        candidateDimId: best.reading.id,
        expectedInches: ref.valueInches,
        actualInches: best.reading.valueInches,
        deltaInches: delta,
        status: "provisional",
      });
    }

    // Span agreement: endpoint sets within spanTol (order-invariant)
    const d1 = dist(ref.span.a, best.a) + dist(ref.span.b, best.b);
    const d2 = dist(ref.span.a, best.b) + dist(ref.span.b, best.a);
    const spanErr = Math.min(d1, d2) / 2;
    const lenRatio =
      Math.min(spanLenPx(ref), dist(best.a, best.b)) /
      Math.max(1, Math.max(spanLenPx(ref), dist(best.a, best.b)));
    const spanOk = spanErr <= spanTol && lenRatio > 0.7;
    if (spanOk) spanHits++;
    else {
      findings.push({
        id: `dim-span-${ref.id}-${best.reading.id}`,
        kind: "dim_span_mismatch",
        message: `Dim span endpoints disagree for ${ref.valueText ?? ref.valueInches}" (mean endpoint err ${spanErr.toFixed(0)}px) — check wall vs dimension-line association`,
        severity: valueOk ? "error" : "warn",
        referenceBBox: spanBBox(ref.span.a, ref.span.b),
        candidateBBox: spanBBox(best.reading.span.a, best.reading.span.b),
        alignedBBox: spanBBox(best.a, best.b),
        referenceDimId: ref.id,
        candidateDimId: best.reading.id,
        expectedInches: ref.valueInches,
        actualInches: best.reading.valueInches,
        status: "provisional",
      });
    }
  }

  for (const c of candidate) {
    if (usedCand.has(c.id)) continue;
    findings.push({
      id: `dim-unmatched-cand-${c.id}`,
      kind: "dim_unmatched_candidate",
      message: `Candidate dim ${c.valueText ?? c.valueInches + '"'} unmatched to reference`,
      severity: "warn",
      candidateBBox: spanBBox(c.span.a, c.span.b),
      candidateDimId: c.id,
      actualInches: c.valueInches,
      status: "provisional",
    });
  }

  const valueScore = reference.length === 0 ? 1 : valueHits / reference.length;
  const spanScore = pairs === 0 ? (reference.length === 0 ? 1 : 0) : spanHits / pairs;
  return { findings, valueScore, spanScore };
}
