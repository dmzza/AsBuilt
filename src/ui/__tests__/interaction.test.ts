import { describe, expect, test } from "vitest";
import {
  CLICK_PX,
  isClickGesture,
  pointerTravelPx,
  shouldRefitForEpoch,
} from "../interaction";

describe("isClickGesture", () => {
  test("identical down/up is a click", () => {
    expect(isClickGesture({ x: 100, y: 50 }, { x: 100, y: 50 })).toBe(true);
  });

  test("sub-threshold jitter is still a click", () => {
    expect(isClickGesture({ x: 100, y: 50 }, { x: 100 + CLICK_PX, y: 50 })).toBe(true);
    expect(isClickGesture({ x: 100, y: 50 }, { x: 103, y: 52 })).toBe(true);
  });

  test("travel beyond threshold is a drag", () => {
    expect(isClickGesture({ x: 100, y: 50 }, { x: 100 + CLICK_PX + 1, y: 50 })).toBe(false);
    expect(pointerTravelPx({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
  });

  test("must use screen pixels — 1px at ppi=2 is 0.5in, which wrongly exceeded a 1/8in world slop", () => {
    // Regression: world-inch slop of 2/16 made any 1px pointer jitter look like a drag
    // at typical plan zoom (ppi≈2), yanking fixtures to the click point.
    const worldSlopInches = 2 / 16;
    const ppi = 2;
    const onePixelInInches = 1 / ppi;
    expect(onePixelInInches).toBeGreaterThan(worldSlopInches);
    // Screen-space check correctly treats 1px as a click:
    expect(isClickGesture({ x: 40, y: 40 }, { x: 41, y: 40 })).toBe(true);
  });
});

describe("shouldRefitForEpoch", () => {
  test("refits when epoch advances and geometry exists", () => {
    expect(shouldRefitForEpoch(0, 1, true)).toBe(true);
    expect(shouldRefitForEpoch(-1, 0, true)).toBe(true);
  });

  test("does not refit for the same epoch (selection rebuilds, orbit preserved)", () => {
    expect(shouldRefitForEpoch(2, 2, true)).toBe(false);
  });

  test("does not refit when there is no geometry", () => {
    expect(shouldRefitForEpoch(0, 1, false)).toBe(false);
  });

  test("demo reload after pan: same model, new epoch → still refit", () => {
    // User orbited away; Demo reloads identical geometry but bumps sceneEpoch.
    expect(shouldRefitForEpoch(5, 6, true)).toBe(true);
  });
});
