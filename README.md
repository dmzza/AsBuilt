# AsBuilt

A **branching, partially-specified** home-modeling tool for as-built drawings and the design concepts that grow out of them.

As-builts are never finished: you measure what you need, guess the rest, correct bad tape reads, and add geometry you omitted. Design concepts build on that moving foundation. AsBuilt treats both of those facts as first-class design constraints — not as bugs to paper over.

```bash
npm install
npm run dev      # Vite app at localhost
npm test         # core + UI smoke tests
npm run check -- examples/two_story   # parse/merge/solve an on-disk project
```

Stack: Vite · React · TypeScript · Zustand · SVG (2D) · Three.js (3D) · Vitest. Pure client-side, local-first, no backend.

---

## The problem this tool is for

Typical CAD / BIM assumes you know the dimensions. Field reality for a home remodel looks more like:

1. You have a handful of tape measurements and a sketch.
2. Everything else is an approximation until you need it.
3. When you re-measure the kitchen, every concept that branched from the as-built needs that correction — without destroying the concept’s own design intent.
4. Real rooms are slightly out of square; diagonals disagree with wall lengths; opposite walls that “should” match sometimes don’t.

AsBuilt is built around those conditions for **architecture** (stud walls, openings, levels), not manufacturing CAD (revolve / loft / freeform solids).

Near-term use cases that shaped the design: interior remodels, an addition, a second story.

---

## Core ideas (the mental model)

These five ideas do almost all the work. Everything else is machinery that implements them.

### 1. Partial specification is the normal state

You do **not** fully constrain a plan before you can draw it. Under-constrained geometry is healthy: free coordinates rest on weak sketch positions (`~(x, y)`), and the **Assumption Audit** lists every `approximated` value — your “what to go measure next” list.

### 2. Provenance is first-class

Every authored dimension carries *why you believe it*:

| Provenance       | Meaning                         | Solver weight | Drag behavior        |
| ---------------- | ------------------------------- | ------------- | -------------------- |
| `measured`       | Tape-measure truth              | Hard          | Locked (won’t move)  |
| `approximated`   | Guess standing in for reality   | Soft          | Free to revise       |
| `designed`       | Concept intent, not reality     | Soft          | Free to revise       |
| `drawn`          | Junction sketch seed only       | Weakest       | Regularizer / gauge  |

Provenance **propagates** through derivation. A wall length bound to an approximated parameter *displays* as approximated. The audit reports root causes, not symptoms.

`designed` exists so “the concept says 14′” is never confused with “someone measured 14′.” That distinction drives conflict rules when the as-built later changes underneath a concept.

### 3. Parameters → geometry → views (three tiers)

```
Tier 1  Parameters     kitchen.width = 11'-6" [measured]
Tier 2  Geometry +     junctions, walls, openings, constraints
        constraints    (coordinates are solver outputs)
Tier 3  Derived views  room loops, grades, 3D mesh, face dims (later)
```

**The wall graph is fundamental; rooms are not.** A wall shared by kitchen and living room is *one wall*, hosted once, opened once. Moving that partition is a one-place edit forever.

`room k : rect(w, d) { … }` is **sugar**: it expands into named junctions, walls, equal-opposite-wall length bindings, and square-corner axes. Those expanded statements can be overridden or tombstoned by name — a trapezoid is “relax one constraint,” not a different room type.

Non-rectilinear plans (L-shapes, shared walls, T-joins) are authored directly on the wall graph. Lengths left unbound derive from **loop closure** (axis runs around a closed loop sum to zero).

### 4. Live inheritance (branching ≈ git, but always rebased)

A design concept is a **layer** that stores only its deltas against a parent:

```
asbuilt.abl                 # master / reality
concepts/galley.abl         # layer galley : asbuilt
concepts/galley-v2.abl      # layer galley-v2 : galley
```

Resolution always merges against the **current tip** of the parent (not a frozen snapshot). Re-measure the kitchen in the as-built → every concept re-solves against the new truth. That is **live inheritance** — the deliberate alternative to “pin revision, rebase later.”

Conflicts are not silent. The review queue classifies them:

1. **Orphaned reference** — concept hosts on something the base deleted.
2. **Contradiction** — hard constraints disagree after merge (e.g. two measurements of the same span).
3. **Masked correction** — base changed a value the concept had overridden (`set … (was …)`).
4. **Geometric interference** *(planned)* — each layer is valid alone; together they clash.

Re-parenting a concept (rebase onto another branch) is rewriting the `layer` header and re-merging.

### 5. The drag rule (GUI = text edits)

Every interactive edit becomes a **deterministic text edit** to the current layer file:

- Drag free geometry bound to an `approximated` / `designed` param → rewrite that param.
- Drag under-constrained geometry → rewrite sketch `~(x, y)` positions.
- Drag can never move a `measured` value (the UI refuses and says why).
- The text view and the graphics view are always the same document.

Hovering a proposed action (review resolution, re-parent, pending field edit, delete) runs the proposal through a **scratch** merge+solve and ghosts the result on the 2D/3D canvases before you commit.

---

## How a project is stored

Projects are directories of plain-text `.abl` files (git-diffable, human-editable):

```
myhouse/
  asbuilt.abl              # root layer (no parent)
  concepts/
    dormer.abl             # layer dormer : asbuilt
    open-plan.abl
```

See `examples/two_story/` for a working multi-level project (levels, stacking, stair void, concept branch).

Canonical formatting is idempotent: re-save is stable, so real git stays useful for history.

---

## The `.abl` language (brief)

Logic-**flavored**, spreadsheet-**lawed**. Named, order-independent statements. Not Prolog (an early draft went there; adversarial review killed it — no positions, no true shadowing, silent failure).

```abl
% Root as-built
layer asbuilt

walltype ext_2x6 { thickness: 6 1/2" }
walltype int_2x4 { thickness: 4 1/2" }

param k.w = 10'-0" [approximated]
param k.d = 12'-0" [measured 2026-07-08]
param lv.w = 14'-0" [measured 2026-07-08]

room k  : rect(k.w, k.d)  { at: ~(14'-9", 0"), walls: int_2x4, height: 8'-1" [measured] }
room lv : rect(lv.w, k.d) { at: ~(0", 0"),     walls: ext_2x6, height: 8'-1" [measured] }

door front { in: lv.south, at: 2'-0" from lv.sw, size: 3'-0" x 6'-8" }
window kw1 { in: k.east,   at: 3'-0" from k.se, size: 3'-0" x 3'-6", sill: 2'-6" }

meas m1 : dist(lv.sw, lv.ne) = 18'-5 1/4" [measured 2026-07-08]
```

Concept layer (only the delta):

```abl
layer dormer : asbuilt

set up.m_d = 14'-0" [designed] (was 12'-0")
```

Useful primitives:

| Statement | Role |
| --------- | ---- |
| `param` / `set` | Base values vs concept overrides (`set` records `(was …)`) |
| `junction` / `wall` | Wall-graph topology |
| `room … : rect(…)` | Rectangular room template (expands) |
| `rectilinear ns.*` | Axis-align a namespace (defeasible per wall) |
| `length(wall) = expr` | Bind a wall to a param or expression |
| `door` / `window` | Hosted in a wall; offset from an endpoint junction |
| `fixture` | Labeled box (appliance, bed, stair footprint, …) |
| `meas` | Independent distance check (diagonals!) — always measured |
| `level up.* { elev: … }` | Everything under `up.` sits at that elevation |
| `stack a on b` | Hard plan coincidence across levels (bearing alignment) |
| `void` | Floor opening (stairwell cut from slab) |
| `delete name` | Tombstone an inherited statement |

Lengths: `12'`, `12'-3"`, `11'-8 1/2"`, `3/4"`. **A bare number means feet** — always write `"` on inch values. Stored internally in 1/64ths of an inch.

Full authoring rules (including sketch→`.abl` conversion and provenance discipline) live in [`.claude/skills/abl-authoring/SKILL.md`](.claude/skills/abl-authoring/SKILL.md). Ground truth for syntax is `src/core/parser.ts`; the canonical printer is `src/core/printer.ts`.

---

## Pipeline

```
.abl layer files
      │
      ▼
   parse  ──►  merge chain (shadowing, tombstones, template expansion,
      │                     static reference checks)
      ▼
   solve  ──►  weighted Gauss-Newton over junction coords + free params
      │         measured = hard · approximated/designed = soft · drawn = weak
      ▼
  2D SVG / 3D Three.js views  ◄── same resolved model
      │
      ▼
 GUI intent  ──►  TextEdit[]  ──►  rewrite current layer file
```

Hard-constraint residual after convergence → **contradiction** diagnostics (suspects listed so you can demote, correct, or relax a rectangle to out-of-square). Soft residuals just pull; under-constrained plans sit where you sketched them.

---

## App UI (what you get today)

- **2D plan** (SVG): walls with thickness, openings, dimension chains, provenance styling, drag/select tools.
- **3D view** (Three.js): extruded walls with opening holes, room slabs, voids, level elevations.
- **Split view**: both at once from the same model.
- **Branch switcher** + parent **ghost overlay** (see the concept against its base).
- **Review panel**: orphans, contradictions, masked corrections — with hover previews of resolutions.
- **Assumption audit**: every approximated value in the lineage.
- **Open / save** project folder (File System Access API where available; download fallback).
- **PNG export** of the 2D sheet with title block.

Demo project boots in-app if you haven’t opened a folder; `examples/two_story/` is the on-disk reference project.

---

## Repository layout

```
src/core/       Framework-free language: parser, printer, merge, solver,
                model views, editkit (propose* → TextEdit[])
src/state/      Zustand store: project, branch, selection, tools, preview
src/ui2d/       SVG plan editor
src/ui3d/       Three.js view
src/App.tsx     Chrome: toolbar, inspector, review, audit, export
examples/       On-disk .abl projects (checked by tests)
scripts/check.ts  CLI: parse + resolve + solve a project dir/file
```

Edits that matter live in `src/core/`. The UI never invents geometry — it only proposes text edits and re-renders the pipeline.

---

## Status

Milestones **M0–M7** are implemented (core spike → 2D editor → measure/provenance UX → openings/fixtures/3D → branching → multi-level → hover previews → **face-referenced measurement**).

**M7 in short:** tape reads can be `{ ref: inner | outer | centerline }` (or per-end `inner, outer`). Centerline stays solver space; face residuals use crossing-wall half-thicknesses. Walltype thickness has provenance and is a stiff-soft solver variable (inner+outer of the same span can still derive true thickness; free params yield first). Face measures of param-bound walls **append a meas** — they never freeze `param = tape + thickness` as measured. Rooms may declare `dims: inner`. Measure UI defaults to **inner only when the room has `dims: inner`**; otherwise centerline (matches existing models).

**Next (from the design plan):**

- **M8 — UI parity** for language features still text-first (level/void/stack tools, walltype catalog editor, space labels, length bindings).
- Deferred: roofs, DXF/printable sheets, mid-wall `on()` junctions, full interference pass, concept pinning, convert-override-to-relative-expression.

The long-form design plan — adversarial history (why not Prolog / not room-primitives), three-tier model, conflict taxonomy, and full milestone list — is checked in as **[docs/design-plan.md](docs/design-plan.md)** (copied from Claude’s plan at `~/.claude/plans/asbuilt-tool.md`).

---

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck + production build |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check -- <file-or-dir>` | Parse / merge / solve; print conflicts & audit |

---

## License

MIT — see [LICENSE](LICENSE).
