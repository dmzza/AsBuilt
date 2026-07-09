import { describe, expect, test } from "vitest";
import { parseLayerFile } from "../parser";
import { printLayerFile } from "../printer";

/** A canonical as-built file: already in printer order/format. */
const CANONICAL = `% The dining L, measured 2026-07-05
layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }

param dl.depth = 13'-0" [measured 2026-07-05]
param dl.east_depth = 8'-0" [measured 2026-07-05]
param dl.south_width = 12'-0" [approximated]
param dl.width = 20'-0" [measured 2026-07-05]

junction dl.e ~(20'-0", 5'-0")
junction dl.k ~(12'-0", 5'-0")
junction dl.ne ~(20'-0", 13'-0")
junction dl.nw ~(0", 13'-0")
junction dl.s ~(12'-0", 0")
junction dl.sw ~(0", 0")

wall dl.east { from: dl.ne, to: dl.e, type: ext_2x6 }
wall dl.inner { from: dl.k, to: dl.s, type: int_2x4 }
wall dl.jog { from: dl.e, to: dl.k, type: int_2x4 }
wall dl.north { from: dl.nw, to: dl.ne, type: ext_2x6 }
wall dl.south { from: dl.s, to: dl.sw, type: ext_2x6 }
wall dl.west { from: dl.sw, to: dl.nw, type: ext_2x6 }

rectilinear dl.*

length(dl.east) = dl.east_depth
length(dl.north) = dl.width
length(dl.south) = dl.south_width
length(dl.west) = dl.depth

space dining { at: ~(6'-0", 6'-0") }
`;

/** Same content, sloppily formatted. */
const SLOPPY = `layer asbuilt
param dl.width=20' [measured 2026-07-05]
param   dl.depth =  13'  [measured 2026-07-05]
param dl.east_depth = 96" [measured 2026-07-05]
param dl.south_width = 12 [approximated]
walltype ext_2x6 {thickness: 6.5"}
walltype int_2x4 { thickness:4 1/2" }
junction dl.sw ~(0", 0")
junction dl.nw ~(0", 13')
junction dl.ne ~(20', 13')
junction dl.e ~(20', 5')
junction dl.k ~(12', 5')
junction dl.s ~(12', 0")
wall dl.west { type: ext_2x6, from: dl.sw, to: dl.nw }
wall dl.north { from: dl.nw, to: dl.ne, type: ext_2x6 }
wall dl.east { from: dl.ne, to: dl.e, type: ext_2x6 }
wall dl.jog { from: dl.e, to: dl.k, type: int_2x4 }
wall dl.inner { from: dl.k, to: dl.s, type: int_2x4 }
wall dl.south { from: dl.s, to: dl.sw, type: ext_2x6 }
rectilinear dl.*
length(dl.north) = dl.width
length(dl.south) = dl.south_width
length(dl.east) = dl.east_depth
length(dl.west) = dl.depth
space dining { at: ~(6', 6') }
`;

const CONCEPT = `layer nw_office : asbuilt

set dl.south_width = 11'-10 3/4" [designed] (was 12'-0")

junction off.c ~(7'-0", 7'-0")

wall office.east { from: off.n, to: off.c, type: int_2x4 }

delete dl.east.axis
`;

describe("canonical round-trip (scenario e)", () => {
  test("canonical file re-saves byte-identical", () => {
    const parsed = parseLayerFile("asbuilt.abl", CANONICAL);
    expect(printLayerFile(parsed)).toBe(CANONICAL);
  });

  test("sloppy input normalizes, then is a fixpoint", () => {
    const once = printLayerFile(parseLayerFile("asbuilt.abl", SLOPPY));
    const twice = printLayerFile(parseLayerFile("asbuilt.abl", once));
    expect(twice).toBe(once);
  });

  test("sloppy and canonical agree semantically (same canonical output, modulo comments)", () => {
    const fromSloppy = printLayerFile(parseLayerFile("a.abl", SLOPPY));
    const fromCanonical = printLayerFile(parseLayerFile("a.abl", CANONICAL));
    expect(fromSloppy).toBe(fromCanonical.replace("% The dining L, measured 2026-07-05\n", ""));
  });

  test("concept layer with set/(was)/delete round-trips", () => {
    const parsed = parseLayerFile("concepts/nw_office.abl", CONCEPT);
    expect(parsed.header.parent).toBe("asbuilt");
    expect(printLayerFile(parsed)).toBe(CONCEPT);
  });

  test("parse errors carry file:line", () => {
    expect(() => parseLayerFile("x.abl", "layer a\nbogus statement here\n")).toThrow(
      /x\.abl:2/,
    );
    expect(() => parseLayerFile("x.abl", "param a.b = 12'\n")).toThrow(/layer header/);
  });
});
