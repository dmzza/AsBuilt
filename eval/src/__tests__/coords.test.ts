import { describe, expect, test } from "vitest";
import { resolveModelCoordCanvas } from "../vision/coords";

describe("resolveModelCoordCanvas", () => {
  test("uses sent size when coords fit", () => {
    const r = resolveModelCoordCanvas({
      sentW: 4000,
      sentH: 2000,
      payloadW: 4000,
      payloadH: 2000,
      points: [
        { x: 500, y: 300 },
        { x: 3500, y: 1800 },
      ],
    });
    expect(r.coordW).toBe(4000);
    expect(r.coordH).toBe(2000);
    expect(r.note).toBeUndefined();
  });

  test("detects 0–1000 coords despite echoed large canvas", () => {
    const r = resolveModelCoordCanvas({
      sentW: 4088,
      sentH: 2168,
      payloadW: 4088,
      payloadH: 2168,
      points: [
        { x: 129, y: 155 },
        { x: 992, y: 155 },
        { x: 129, y: 805 },
        { x: 992, y: 805 },
      ],
    });
    expect(r.coordW).toBe(1000);
    expect(r.coordH).toBe(1000);
    expect(r.note).toMatch(/0–1000/);
  });

  test("sparse corner pixels stay pixel space", () => {
    const r = resolveModelCoordCanvas({
      sentW: 4088,
      sentH: 2168,
      payloadW: 4088,
      payloadH: 2168,
      points: [
        { x: 129, y: 155 },
        { x: 992, y: 400 },
      ],
    });
    expect(r.coordW).toBe(4088);
    expect(r.coordH).toBe(2168);
    expect(r.note).toBeUndefined();
  });

  test("honors small declared canvas", () => {
    const r = resolveModelCoordCanvas({
      sentW: 4088,
      sentH: 2168,
      payloadW: 1000,
      payloadH: 530,
      points: [
        { x: 129, y: 80 },
        { x: 992, y: 400 },
      ],
    });
    expect(r.coordW).toBe(1000);
    expect(r.coordH).toBe(530);
  });
});
