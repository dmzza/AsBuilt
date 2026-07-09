/**
 * Built-in demo project: the L-shaped dining room (authored on the wall
 * graph, partially measured) plus a rect-template kitchen, and one concept.
 * Files are in canonical form so re-save is byte-identical.
 */

export const DEMO_FILES: Record<string, string> = {
  "asbuilt.abl": `% AsBuilt demo: L-shaped dining room + rectangular kitchen
layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }

param dl.depth = 13'-0" [measured 2026-07-05]
param dl.east_depth = 8'-0" [measured 2026-07-05]
param dl.south_width = 12'-0" [approximated]
param dl.width = 20'-0" [measured 2026-07-05]
param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 11'-6" [approximated]

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

door d1 { in: k.west, at: 2'-6" from k.sw, size: 2'-8" x 6'-8" }
window win1 { in: dl.north, at: 4'-0" from dl.nw, size: 4'-0" x 3'-0", sill: 2'-6" }

room k : rect(k.width, k.depth) { at: ~(24'-0", 0"), walls: int_2x4, height: 8'-0" [measured] }

rectilinear dl.*

length(dl.east) = dl.east_depth
length(dl.north) = dl.width
length(dl.south) = dl.south_width
length(dl.west) = dl.depth

fixture fridge { kind: fridge, at: ~(26'-0", 8'-0"), size: 3'-0" x 2'-6" }

space dining { at: ~(6'-0", 6'-0") }
`,
  "concepts/galley.abl": `% Concept: narrow the kitchen to a galley
layer galley : asbuilt

set k.width = 9'-6" [designed] (was 11'-6")
`,
};

export const DEMO_BRANCH = "asbuilt";
