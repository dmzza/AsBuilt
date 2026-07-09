/**
 * Lengths are stored as integer counts of 1/64 inch ("s64").
 * Exact for every tape-measure value; closure sums stay exact integers.
 * The solver converts to float inches at its boundary.
 */

export type S64 = number; // integer 1/64ths of an inch

export const S64_PER_INCH = 64;
export const S64_PER_FOOT = 64 * 12;

export function s64FromInches(inches: number): S64 {
  return Math.round(inches * S64_PER_INCH);
}

export function s64ToInches(v: S64): number {
  return v / S64_PER_INCH;
}

export function s64FromFeet(feet: number): S64 {
  return Math.round(feet * S64_PER_FOOT);
}

export class LengthParseError extends Error {
  constructor(public readonly input: string, detail: string) {
    super(`Cannot parse length "${input}": ${detail}`);
    this.name = "LengthParseError";
  }
}

const FRACTION_RE = /^(\d+)\s*\/\s*(\d+)$/;
const NUMBER_RE = /^\d+(?:\.\d+)?$|^\.\d+$/;

/**
 * Parse a length. Accepted forms (whitespace-tolerant):
 *   12'            12'-3"        12'3"         12' 3"
 *   12'-3 1/2"     12'3.5"       3 1/2"        140.5"      6"
 * Marker-free entry forms (field/UI convenience):
 *   12             -> 12 feet
 *   12 3           -> 12'-3"
 *   12 3 1/2       -> 12'-3 1/2"
 * Fractions with denominators that don't divide 64 round to the nearest 1/64".
 */
export function parseLength(input: string): S64 {
  let text = input.trim();
  if (text.length === 0) throw new LengthParseError(input, "empty");

  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1).trim();
  }

  const hasFeetMark = text.includes("'");
  const hasInchMark = text.includes('"');

  let feet = 0;
  let inchText = text;

  if (hasFeetMark) {
    const [feetPart, ...rest] = text.split("'");
    const feetTrim = (feetPart ?? "").trim();
    if (!NUMBER_RE.test(feetTrim)) {
      throw new LengthParseError(input, `bad feet part "${feetTrim}"`);
    }
    feet = parseFloat(feetTrim);
    inchText = rest.join("'").trim();
    // tolerate the conventional hyphen separator: 12'-3"
    if (inchText.startsWith("-")) inchText = inchText.slice(1).trim();
  } else if (!hasInchMark) {
    // Marker-free entry: 1-3 whitespace-separated fields = feet [inches [fraction]]
    const fields = text.split(/\s+/);
    if (fields.length > 3) throw new LengthParseError(input, "too many fields");
    const [f, i, fr] = fields;
    if (f === undefined || !NUMBER_RE.test(f)) {
      throw new LengthParseError(input, `bad feet part "${f ?? ""}"`);
    }
    let total = s64FromFeet(parseFloat(f));
    if (i !== undefined) {
      if (!NUMBER_RE.test(i)) throw new LengthParseError(input, `bad inches part "${i}"`);
      total += s64FromInches(parseFloat(i));
    }
    if (fr !== undefined) {
      const m = FRACTION_RE.exec(fr);
      if (!m) throw new LengthParseError(input, `bad fraction "${fr}"`);
      total += s64FromInches(parseInt(m[1]!, 10) / parseInt(m[2]!, 10));
    }
    return sign * total;
  }

  // inchText: '' | '3' | '3"' | '3.5"' | '3 1/2"' | '1/2"' | '140.5"'
  inchText = inchText.replace(/"$/, "").trim();
  let inches = 0;
  if (inchText.length > 0) {
    const fields = inchText.split(/\s+/);
    if (fields.length === 1) {
      const only = fields[0]!;
      const fm = FRACTION_RE.exec(only);
      if (fm) {
        inches = parseInt(fm[1]!, 10) / parseInt(fm[2]!, 10);
      } else if (NUMBER_RE.test(only)) {
        inches = parseFloat(only);
      } else {
        throw new LengthParseError(input, `bad inches part "${only}"`);
      }
    } else if (fields.length === 2) {
      const [whole, frac] = fields;
      const fm = FRACTION_RE.exec(frac!);
      if (!NUMBER_RE.test(whole!) || !fm) {
        throw new LengthParseError(input, `bad inches part "${inchText}"`);
      }
      inches = parseFloat(whole!) + parseInt(fm[1]!, 10) / parseInt(fm[2]!, 10);
    } else {
      throw new LengthParseError(input, `bad inches part "${inchText}"`);
    }
  }

  return sign * (s64FromFeet(feet) + s64FromInches(inches));
}

function reduceFraction(n: number, d: number): [number, number] {
  while (n % 2 === 0 && d % 2 === 0) {
    n /= 2;
    d /= 2;
  }
  return [n, d];
}

/**
 * Canonical architectural format: 11'-8 1/2", 12'-0", 6 1/2", 3/4", 0".
 * formatLength(parseLength(s)) is a fixpoint; parseLength(formatLength(v)) === v.
 */
export function formatLength(v: S64): string {
  if (!Number.isInteger(v)) throw new Error(`formatLength: non-integer s64 ${v}`);
  const sign = v < 0 ? "-" : "";
  let rest = Math.abs(v);
  const feet = Math.floor(rest / S64_PER_FOOT);
  rest -= feet * S64_PER_FOOT;
  const inches = Math.floor(rest / S64_PER_INCH);
  const frac64 = rest - inches * S64_PER_INCH;

  let inchStr: string;
  if (frac64 === 0) {
    inchStr = `${inches}"`;
  } else {
    const [n, d] = reduceFraction(frac64, S64_PER_INCH);
    inchStr = inches > 0 ? `${inches} ${n}/${d}"` : `${n}/${d}"`;
  }

  if (feet > 0) {
    // Inside feet-inches, a bare fraction still needs the 0: 12'-0 1/2"
    if (frac64 !== 0 && inches === 0) {
      const [n, d] = reduceFraction(frac64, S64_PER_INCH);
      inchStr = `0 ${n}/${d}"`;
    }
    return `${sign}${feet}'-${inchStr}`;
  }
  return `${sign}${inchStr}`;
}
