import { describe, expect, test } from "vitest";
import { deriveVisionStatus } from "../vision/status";

describe("deriveVisionStatus", () => {
  test("missing API key is loud", () => {
    const s = deriveVisionStatus({
      notes: [
        "Align: scale=1 rot=0°",
        "ref: No ANTHROPIC_API_KEY or OPENAI_API_KEY — skipped vision dim extraction. Provide gold dims or set a key.",
        "cand: No ANTHROPIC_API_KEY or OPENAI_API_KEY — skipped vision dim extraction. Provide gold dims or set a key.",
        "No vision client — skipped topology vision pass",
      ],
      referenceDimCount: 0,
      candidateDimCount: 0,
      usedReferenceGold: false,
      usedCandidateGold: false,
    });
    expect(s.availability).toBe("missing_key");
    expect(s.label).toMatch(/API key/i);
  });

  test("vision used", () => {
    const s = deriveVisionStatus({
      notes: [
        "ref: Vision provider: anthropic / claude-sonnet-5",
        "ref: Full-page pass found 10 dimension(s)",
        "cand: Vision provider: anthropic / claude-sonnet-5",
        "Vision topology: 2 finding(s)",
      ],
      referenceDimCount: 10,
      candidateDimCount: 12,
      usedReferenceGold: false,
      usedCandidateGold: false,
    });
    expect(s.availability).toBe("used");
    expect(s.model).toBe("claude-sonnet-5");
  });

  test("partial extract failure", () => {
    const s = deriveVisionStatus({
      notes: [
        "ref: Vision provider: anthropic / claude-sonnet-5",
        "ref: Full-page extract failed: Unexpected end of JSON input",
        "ref: Tile passes contributed 39 raw reading(s)",
      ],
      referenceDimCount: 35,
      candidateDimCount: 0,
      usedReferenceGold: false,
      usedCandidateGold: false,
    });
    expect(s.availability).toBe("partial");
  });

  test("gold only", () => {
    const s = deriveVisionStatus({
      notes: [
        "Using 8 verified reference gold dim(s)",
        "Using 8 verified candidate gold dim(s)",
        "No vision client — skipped topology vision pass",
      ],
      referenceDimCount: 8,
      candidateDimCount: 8,
      usedReferenceGold: true,
      usedCandidateGold: true,
    });
    expect(s.availability).toBe("gold_only");
  });
});
