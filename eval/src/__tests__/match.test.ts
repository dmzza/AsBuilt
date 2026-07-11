import { describe, expect, test } from "vitest";
import { matchDimensions } from "../dims/match";
import { parseDimText, formatInches } from "../image";
import type { DimReading, SimilarityTransform } from "../types";

const identity: SimilarityTransform = { scale: 1, rotation: 0, tx: 0, ty: 0 };

function dim(
  id: string,
  inches: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): DimReading {
  return {
    id,
    valueInches: inches,
    valueText: formatInches(inches),
    labelBBox: { x: (ax + bx) / 2 - 20, y: (ay + by) / 2 - 10, w: 40, h: 16 },
    span: { a: { x: ax, y: ay }, b: { x: bx, y: by } },
  };
}

describe("parseDimText", () => {
  test("feet-inches", () => {
    expect(parseDimText(`13'-0"`)).toBe(156);
    expect(parseDimText(`11'-8 1/2"`)).toBeCloseTo(140.5);
    expect(parseDimText(`6 1/2"`)).toBeCloseTo(6.5);
  });
});

describe("matchDimensions", () => {
  test("pairs by proximity and flags value mismatch", () => {
    const ref = [dim("r1", 156, 10, 10, 10, 200)];
    const cand = [dim("c1", 150, 12, 12, 12, 198)];
    const r = matchDimensions(ref, cand, identity, { dimInches: 0.5 });
    expect(r.valueScore).toBe(0);
    expect(r.findings.some((f) => f.kind === "dim_value_mismatch")).toBe(true);
  });

  test("perfect match scores 1", () => {
    const ref = [dim("r1", 120, 0, 0, 100, 0)];
    const cand = [dim("c1", 120, 1, 1, 101, 1)];
    const r = matchDimensions(ref, cand, identity, { dimInches: 0.5, spanPx: 48 });
    expect(r.valueScore).toBe(1);
    expect(r.spanScore).toBe(1);
  });

  test("span mismatch when endpoints disagree", () => {
    const ref = [dim("r1", 120, 0, 0, 200, 0)];
    const cand = [dim("c1", 120, 0, 0, 50, 0)]; // same value, wrong span
    const r = matchDimensions(ref, cand, identity, { dimInches: 0.5, spanPx: 20 });
    expect(r.valueScore).toBe(1);
    expect(r.spanScore).toBe(0);
    expect(r.findings.some((f) => f.kind === "dim_span_mismatch")).toBe(true);
  });

  test("empty reference dims score 0 (not vacuous 1)", () => {
    const r = matchDimensions([], [dim("c1", 120, 0, 0, 100, 0)], identity);
    expect(r.valueScore).toBe(0);
    expect(r.spanScore).toBe(0);
  });
});
