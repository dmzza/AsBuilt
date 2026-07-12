import { describe, expect, test } from "vitest";
import {
  countImageTokens,
  resizedSize,
  resizedSizeForModel,
  scalePointFromResized,
  tierForModel,
} from "../vision/resize";

describe("Anthropic vision resizedSize", () => {
  test("A4 example from Anthropic docs (standard tier)", () => {
    expect(resizedSize(1075, 1520)).toEqual([924, 1307]);
  });

  test("image already within limits is unchanged", () => {
    expect(resizedSize(800, 600)).toEqual([800, 600]);
  });

  test("token count formula", () => {
    expect(countImageTokens(28, 28)).toBe(1);
    expect(countImageTokens(29, 28)).toBe(2);
  });

  test("claude-sonnet-5 uses high-res tier", () => {
    expect(tierForModel("claude-sonnet-5")).toBe("high");
    // 5024×2664 Maynard reference must shrink under high-res limits
    const [w, h] = resizedSizeForModel(5024, 2664, "claude-sonnet-5");
    expect(w).toBeLessThanOrEqual(2576);
    expect(h).toBeLessThanOrEqual(2576);
    expect(countImageTokens(w, h)).toBeLessThanOrEqual(4784);
    expect(w).toBeGreaterThan(1000);
  });

  test("gemini uses generous tier", () => {
    expect(tierForModel("gemini-3.5-flash")).toBe("gemini");
    const [w, h] = resizedSizeForModel(5024, 2664, "gemini-3.5-flash");
    expect(w).toBeLessThanOrEqual(4096);
    expect(h).toBeLessThanOrEqual(4096);
    expect(w).toBeGreaterThan(2000);
  });

  test("scalePointFromResized maps back to original", () => {
    const p = scalePointFromResized({ x: 100, y: 50 }, 2000, 1000, 1000, 500);
    expect(p.x).toBe(200);
    expect(p.y).toBe(100);
  });
});
