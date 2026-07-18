import { describe, expect, test, vi, beforeEach } from "vitest";
import { deriveAblEvalLayersFromFiles } from "../../asbuilt/serialize";

const extractStructure = vi.fn(async () => {
  throw new Error("extractStructure should not be called when overrides are set");
});
const extractDimensions = vi.fn(async () => {
  throw new Error("extractDimensions should not be called when gold/overrides are set");
});
const visionTopologyFindings = vi.fn(async () => ({
  findings: [],
  notes: ["No vision client — skipped topology vision pass"],
}));

vi.mock("../structure/extract", () => ({
  extractStructure: (...args: unknown[]) => extractStructure(...args),
}));
vi.mock("../dims/extract", () => ({
  extractDimensions: (...args: unknown[]) => extractDimensions(...args),
  visionTopologyFindings: (...args: unknown[]) => visionTopologyFindings(...args),
}));

const TINY_ABL = {
  "asbuilt.abl": `layer asbuilt

walltype std { thickness: 4 1/2" }

param w = 10'-0" [measured]
param d = 8'-0" [measured]

junction a ~(0", 0")
junction b ~(10'-0", 0")
junction c ~(10'-0", 8'-0")
junction dj ~(0", 8'-0")

wall south { from: a, to: b, type: std }
wall east { from: b, to: c, type: std }
wall north { from: c, to: dj, type: std }
wall west { from: dj, to: a, type: std }

axis south h
axis east v
axis north h
axis west v

length(south) = w
length(east) = d
length(north) = w
length(west) = d

meas m1 : dist(a, b) = 10'-0" [measured]
`,
};

describe("scorePlanPair ABL overrides", () => {
  beforeEach(() => {
    extractStructure.mockClear();
    extractDimensions.mockClear();
    visionTopologyFindings.mockClear();
  });

  test("skips structure/dims AI when both sides provide ABL overrides", async () => {
    const { scorePlanPair } = await import("../score");
    const layers = deriveAblEvalLayersFromFiles(TINY_ABL, { ppi: 5 });

    const result = await scorePlanPair({
      reference: layers.fullPng,
      candidate: layers.fullPng,
      referenceGold: layers.dims,
      candidateGold: layers.dims,
      referenceStructure: layers.structure,
      candidateStructure: layers.structure,
      referenceStructurePng: layers.structurePng,
      candidateStructurePng: layers.structurePng,
      referenceDimsPng: layers.dimsPng,
      candidateDimsPng: layers.dimsPng,
      useVision: true,
    });

    expect(extractStructure).not.toHaveBeenCalled();
    expect(extractDimensions).not.toHaveBeenCalled();
    expect(result.structureCleaned?.reference).toBe("skipped");
    expect(result.structureCleaned?.candidate).toBe("skipped");
    expect(result.dimsCleaned?.reference).toBe("skipped");
    expect(result.dimsCleaned?.candidate).toBe("skipped");
    expect(result.referenceStructure?.wallSpans.length).toBe(4);
    expect(result.candidateStructure?.wallSpans.length).toBe(4);
    expect(result.notes.some((n) => /derived from \.abl/i.test(n))).toBe(true);
    expect(result.overlays.structureRefPng).toBe("structure_ref.png");
    expect(result.overlays.dimsCandPng).toBe("dims_cand.png");
  });
});
