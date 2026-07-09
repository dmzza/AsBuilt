---
name: abl-authoring
description: Use when writing or editing .abl files for the AsBuilt app — especially when converting an image (photo or scan of a hand-drawn floor plan with tape-measure dimensions) into an .abl project. Covers the full .abl language, provenance discipline, the conversion method, and validation. Triggers - "convert this sketch/drawing/photo to abl", "model this floor plan", any .abl file authoring.
---

# Authoring .abl files (and converting sketches to them)

`.abl` is this repo's declarative constraint language for partially-specified
architectural models. Ground truth for syntax is `src/core/parser.ts`; the
canonical formatter is `src/core/printer.ts`. **Always validate your output**
with `npm run check -- <file-or-dir>` before delivering it.

The load-bearing idea: every dimension records its **provenance**. The solver
treats `measured` values as hard truth, `approximated` values as soft guesses,
and junction sketch positions as the weakest hints. Rooms do not need to be
fully dimensioned — under-constrained is the normal, healthy state, and the
app's audit panel tells the owner what to go measure next.

## Converting a hand-drawn sketch: the method

### 1. Transcribe before you model

List every written dimension from the image with its location ("north wall of
kitchen: 11'-8 1/2"", "diagonal living room: 15'-1""). Also note room names,
door/window positions with any offsets, arrows, and out-of-square annotations.
If handwriting is ambiguous (4 vs 9, 1 vs 7, missing units), **ask the user —
never guess a reading into the file**.

### 2. Provenance discipline (the point of the whole tool)

- A number **written on the drawing** → `[measured]` (add the date if known:
  `[measured 2026-07-09]`).
- A value you **infer** from proportions, typical construction, or symmetry →
  `[approximated]`.
- `[designed]` is only for concept-layer intent, never for as-builts.
- Omitting the bracket means `[approximated]`.
- If the drawing gives **conflicting readings** (e.g. opposite walls written
  11'-11" and 12'-0"), record BOTH faithfully as measurements — the app
  surfaces the contradiction and lets the owner pick what gives. Do not
  average, do not discard. Mention expected conflicts in your summary.

### 3. Choose the representation per room

- Plain rectangular room, no shared-wall subtleties →
  `room name : rect(width_param, depth_param) { at: ~(x, y), walls: type, height: ... }`.
  It expands to junctions `name.sw/.se/.ne/.nw`, walls
  `name.south/.east/.north/.west`, equal-opposite-wall bindings, and square
  corners. `at:` is the **SW corner**.
- L-shapes, shared walls, anything irregular → author the wall graph directly:
  `junction` + `wall` + `rectilinear ns.*` + `length(wall) = param` bindings.
  Bind lengths **only** for spans that have written dimensions or that you
  need to reference; walls left unbound derive from loop closure (that's a
  feature — their displayed provenance is computed automatically).
- A wall between two rooms is **one wall**. Never author it twice. Room
  templates cannot share walls yet, so any region with shared interior walls
  should be authored on the wall graph.

### 4. Coordinates and scale

Origin at the plan's SW corner; x runs east, y runs north; ALL coordinates in
length literals. Junction `~(x, y)` sketch positions are weak solver hints:
estimate them from image proportions scaled by the written dimensions. Rough
is fine (within a foot or two); topology must be right, precision must not be
faked. The solver reconciles everything against the measured values.

### 5. Openings, fixtures, diagonals

- Doors/windows are hosted in a wall and anchored to one of that wall's
  **endpoint junctions** (see wall endpoint table below). Anchor to the
  nearer endpoint; the offset is along the wall to the near jamb. Written
  offsets are measurements — but note the offset literal itself carries no
  provenance bracket, so put `% measured` in a comment if it was taped.
- Diagonal check measurements → `meas name : dist(a, b) = value [measured]`.
  Transcribe every diagonal on the drawing; they're how the tool detects
  out-of-square rooms.
- Furniture/appliances → `fixture` boxes (`at:` is the **center**).

### 6. Wall types

Default unless the drawing says otherwise (note assumptions in comments):

```abl
walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }
```

### 7. Validate, then summarize

```
npm run check -- path/to/project-dir
```

Must parse and resolve with **zero errors**. CONFLICT lines are acceptable if
they reflect genuine disagreements on the drawing — explain each one to the
user. Include in your summary: the audit list (what's still approximated),
any conflicts and their suspects, and any assumption you made.

## Language reference

One statement per line. Comments: `%` to end of line. Names are lowercase
`[a-z_][a-z0-9_]*` with optional dotted segments (`kitchen.width`); no
hyphens or capitals. The first statement must be the layer header.

### Length literals

`12'` · `12'-3"` · `12'3"` · `11'-8 1/2"` · `3/4"` · `140.5"` · `12'3.5"`
Fractions are stored exactly in 1/64ths. **A bare number with no marks means
FEET** (`12` = twelve feet) — always write the `"` on inch values.

### Expressions (param arithmetic)

`k.width` · `k.width - 1'-6"` · `a + b`. Spaces around `+`/`-` are REQUIRED.

### Statements

```abl
layer asbuilt                      % root layer, no parent
layer galley : asbuilt             % concept layer (in concepts/galley.abl)

walltype int_2x4 { thickness: 4 1/2" }

param k.width = 11'-6" [measured 2026-07-05]
param k.depth = 10'-0"             % no bracket = [approximated]

set k.width = 9'-6" [designed] (was 11'-6")   % concept override; record (was ...)

junction dl.sw ~(0", 0")           % ~ = weak sketch position, inches/feet
wall dl.south { from: dl.s, to: dl.sw, type: ext_2x6 }

door d1 { in: k.west, at: 2'-6" from k.sw, size: 2'-8" x 6'-8" }
window win1 { in: dl.north, at: 4'-0" from dl.nw, size: 4'-0" x 3'-0", sill: 2'-6" }

room k : rect(k.width, k.depth) { at: ~(24'-0", 0"), walls: int_2x4, height: 8'-0" [measured] }

rectilinear dl.*                   % axis-align every dl.* wall (defeasible per wall)
axis w1 h                          % single-wall axis constraint (h or v)

length(dl.north) = dl.width        % bind a wall's length to an expression

meas m1 : dist(dl.sw, dl.ne) = 23'-11 1/4" [measured 2026-07-09]   % diagonals!

fixture fridge { kind: fridge, at: ~(26'-0", 8'-0"), size: 3'-0" x 2'-6", rot: 90 }

space dining { at: ~(6'-0", 6'-0") }   % room label point

delete k.south.length              % tombstone (e.g. relax a rect default)
```

### rect() expansion & wall endpoints (needed for opening anchors)

`room k : rect(w, d)` creates a CCW loop; each wall's endpoints (valid
`from`-anchors for openings in that wall):

| wall      | runs        | endpoints        |
| --------- | ----------- | ---------------- |
| `k.south` | sw → se     | `k.sw`, `k.se`   |
| `k.east`  | se → ne     | `k.se`, `k.ne`   |
| `k.north` | ne → nw     | `k.ne`, `k.nw`   |
| `k.west`  | nw → sw     | `k.nw`, `k.sw`   |

Expanded, tombstone-able keys: `k.<side>.length` (equal-walls binding),
`k.<side>.axis` (square-corner default), `k.space`.

### Layering semantics

A concept layer shadows by statement name: restating a name replaces it,
`set` overrides a param recording `(was ...)`, `delete` tombstones. Concepts
live in `concepts/<name>.abl`. Everything not overridden inherits live from
the parent.

### Gotchas

- `meas` is always `[measured]` — the parser rejects other provenance.
- Opening `at:` anchors must be endpoint junctions of the host wall.
- Room `at:` = SW corner; fixture `at:` = center.
- Missing `"` on an inch value silently means feet. Re-read your literals.
- Don't bind both a room template's width AND add a `meas` for the same span
  with the same value — measuring the span means promoting the param to
  `[measured]` instead. A `meas` duplicating a bound span is only right when
  it's a genuinely different reading (then it's a conflict for the owner).

## Worked micro-example

Drawing shows: rectangular bedroom, "11'-2"" written on the north wall,
"12'-8"" on the east wall, a door in the south wall about 3' from the SW
corner, a window centered-ish in the north wall, diagonal written "16'-11"".

```abl
% Bedroom from sketch photo, 2026-07-09. Door offset scaled, not taped.
layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }

param bed.depth = 12'-8" [measured 2026-07-09]
param bed.width = 11'-2" [measured 2026-07-09]

door d1 { in: bed.south, at: 3'-0" from bed.sw, size: 2'-8" x 6'-8" }
window win1 { in: bed.north, at: 3'-6" from bed.nw, size: 4'-0" x 3'-0", sill: 2'-6" }

room bed : rect(bed.width, bed.depth) { at: ~(0", 0"), walls: ext_2x6 }

meas m_diag : dist(bed.sw, bed.ne) = 16'-11" [measured 2026-07-09]
```

Then: `npm run check -- <dir>` reports:

```
CONFLICT measurements disagree (off by 1/8"); suspects: bed.depth, ..., bed.width, m_diag
drift   bed.depth: authored 12'-8", solves to 12'-8 3/32"
```

That is CORRECT output, not a mistake to fix: √(134² + 152²) ≈ 202.63" but
the tape said 203" — the room is slightly out of square or a reading is off
by ~3/8", and that decision belongs to the owner in the app (demote a
reading, or relax the square-corner default). Deliver the file as-is and
explain the conflict; do not fudge any value to silence it.
