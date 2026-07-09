import { describe, expect, test } from "vitest";
import {
  formatLength,
  parseLength,
  s64FromFeet,
  s64FromInches,
  S64_PER_FOOT,
  S64_PER_INCH,
} from "../units";

describe("parseLength", () => {
  test("feet only", () => {
    expect(parseLength("12'")).toBe(12 * S64_PER_FOOT);
  });

  test("architectural hyphenated", () => {
    expect(parseLength(`12'-3"`)).toBe(12 * S64_PER_FOOT + 3 * S64_PER_INCH);
    expect(parseLength(`12'-0"`)).toBe(12 * S64_PER_FOOT);
  });

  test("feet-inches without hyphen or with space", () => {
    expect(parseLength(`12'3"`)).toBe(12 * S64_PER_FOOT + 3 * S64_PER_INCH);
    expect(parseLength(`12' 3"`)).toBe(12 * S64_PER_FOOT + 3 * S64_PER_INCH);
  });

  test("fractions", () => {
    expect(parseLength(`11'-8 1/2"`)).toBe(11 * S64_PER_FOOT + 8.5 * S64_PER_INCH);
    expect(parseLength(`3 1/2"`)).toBe(3.5 * S64_PER_INCH);
    expect(parseLength(`3/4"`)).toBe(48);
    expect(parseLength(`12'-0 1/2"`)).toBe(12 * S64_PER_FOOT + 32);
  });

  test("decimal inches", () => {
    expect(parseLength(`140.5"`)).toBe(140.5 * S64_PER_INCH);
    expect(parseLength(`12'3.5"`)).toBe(12 * S64_PER_FOOT + 3.5 * S64_PER_INCH);
  });

  test("marker-free field entry", () => {
    expect(parseLength("12")).toBe(12 * S64_PER_FOOT);
    expect(parseLength("12 3")).toBe(12 * S64_PER_FOOT + 3 * S64_PER_INCH);
    expect(parseLength("12 3 1/2")).toBe(12 * S64_PER_FOOT + 3.5 * S64_PER_INCH);
  });

  test("negative", () => {
    expect(parseLength(`-1'-6"`)).toBe(-(S64_PER_FOOT + 6 * S64_PER_INCH));
  });

  test("odd fractions round to nearest 1/64", () => {
    expect(parseLength(`1/3"`)).toBe(21); // 64/3 = 21.33 -> 21
  });

  test("garbage rejected", () => {
    expect(() => parseLength("")).toThrow();
    expect(() => parseLength("abc")).toThrow();
    expect(() => parseLength("12 3 4 5")).toThrow();
    expect(() => parseLength(`x'`)).toThrow();
  });
});

describe("formatLength", () => {
  test("canonical forms", () => {
    expect(formatLength(s64FromFeet(12))).toBe(`12'-0"`);
    expect(formatLength(s64FromInches(140.5))).toBe(`11'-8 1/2"`);
    expect(formatLength(s64FromInches(6.5))).toBe(`6 1/2"`);
    expect(formatLength(48)).toBe(`3/4"`);
    expect(formatLength(0)).toBe(`0"`);
    expect(formatLength(12 * S64_PER_FOOT + 32)).toBe(`12'-0 1/2"`);
    expect(formatLength(-(S64_PER_FOOT + 6 * S64_PER_INCH))).toBe(`-1'-6"`);
  });

  test("round-trip: parse(format(v)) === v across the range", () => {
    for (let v = -2 * S64_PER_FOOT; v <= 30 * S64_PER_FOOT; v += 7) {
      expect(parseLength(formatLength(v))).toBe(v);
    }
  });

  test("fixpoint: format(parse(s)) stable for canonical strings", () => {
    for (const s of [`12'-0"`, `11'-8 1/2"`, `6 1/2"`, `3/4"`, `0"`, `12'-0 1/2"`]) {
      expect(formatLength(parseLength(s))).toBe(s);
    }
  });
});
