# AsBuilt — a branching, partially-specified home-modeling tool

> Design plan from the Claude Code session that invented the tool (originally
> `~/.claude/plans/asbuilt-tool.md`, 2026-07-08). Kept here as the long-form
> rationale behind the concepts summarized in the root [README](../README.md).
> Status notes and later milestone outcomes live in Claude project memory, not
> this file — treat milestones as the intended sequence, and the README / git
> log as “what’s actually shipped.”

## Context

David is preparing major phased construction projects on his home (interior remodels, an addition, a second story). He needs a tool where:

1. **Drawings are only ever partially specified.** Dimensions are `measured` or `approximated`; you refine over time, replace guesses with tape-measure truth, correct bad measurements, and add omitted geometry. The model absorbs corrections instead of fighting them.
2. **Design concepts are branches** off the as-built (or off other concepts), with **live inheritance**: base corrections flow into every downstream concept automatically; anything problematic surfaces in a review queue instead of applying silently.
3. **2D ⇄ 3D**: one model, edited in a 2D drafting view or a Three.js 3D view.
4. **Architecture-native primitives**: stud walls with thickness/assemblies, openings, rooms, levels — not manufacturing CAD.
5. Units: **feet & inches** (architectural fractional). Outputs: on-screen first, PNG early, sheets/DXF later.

An earlier draft pivoted to a literal Prolog file format. Adversarial review found fatal holes: no positions (couldn't render a plan), shared walls duplicated (the exact sin the design was meant to kill), Prolog accumulates rather than shadows (branch override semantics didn't exist), "bidirectional" required an unbuilt CLP system, silent closed-world failure, stud walls/thickness lost, drag-editing a free-form program unsolved. This plan keeps the semantics David liked — define once, relations as rules, surgical overrides — and grounds them in a constraint system that can actually draw.

## Design overview: three tiers

**Tier 1 — Parameters.** Named quantities with provenance: `kitchen.width = 11'-6" [measured]`. These are what dimensions display, what the audit lists, what branches override.

**Tier 2 — Geometry + constraints.** Junctions (points), walls (junction pairs + assembly + height), openings hosted in walls, levels. Coordinates are **solver outputs**, never authored truth. Authored statements are constraints binding geometry to parameters: `length(kitchen.north) = kitchen.width`, `angle(kitchen.ne) = 90°`, a measured diagonal is just a distance constraint between two junctions.

**Tier 3 — Derived views.** Rooms as closed loops in the wall graph, interior face-to-face dimensions (centerline minus assembly thickness), areas, the 3D mesh. Derived, never stored. Space labels bind to loops by point-in-loop test; when new walls change the loops (e.g., a concept splits a room with a partition), labels re-bind or are overridden by name, and ambiguous bindings are flagged rather than guessed.

This fixes the room-primitive trap: **the wall graph is fundamental; a wall bounding two rooms is one wall.** Moving the kitchen/living wall is a one-place edit forever.

## The language (`.abl`)

Logic-*flavored*, spreadsheet-*lawed*. Explicitly **not Prolog**:

- **Named statements, order-independent.** Every param/element/constraint has a stable name. No clause order, no cut, no SLD resolution.
- **Shadowing is defined, not emergent.** A layer (branch) redefining a name replaces it. Deleting is an explicit tombstone.
- **Defeasible defaults.** Templates (e.g., `rect`) expand deterministically into named primitives + default constraints (opposite walls share one parameter, corners 90°). Overriding any expanded statement by name pierces the template — trapezoid = override one constraint, nothing restructures.
- **Static reference checking.** Unknown names are *errors at merge time*, not silently-empty queries. Orphaned references become review-queue items, never missing geometry.
- **Junctions can lie mid-wall**: `junction j : on(some.wall, at: 9'-0" clear from other.wall)` — a T-join. The host wall stays one authored entity (one plate run, as built); the wall graph gains a node. This is how a concept splits a room into two while retaining every original wall: two `on()` junctions + one partition + re-bound space labels, zero edits to base walls. `clear from` anchors to the interior face (tape-measure semantics, the default); centerline anchoring available. Free (unhosted) junctions serve as partition corners in open space — position fully determined by constraints, sketch `~` as solver seed only.
- **Templates are sugar, never structure.** Non-rectangular rooms (L-shapes, etc.) are authored directly on the wall graph: junctions, walls, `rectilinear`, param bindings on the spans you care about. Wall lengths left unbound derive from **loop closure** (X-runs and Y-runs around a loop each sum to zero), with provenance propagated from the inputs. `rect` exists because rectangles are common, not because rooms must be rectangles.
- **Bidirectional numerics via the solver**, not via logic resolution. "If north is 14', what's width?" works because both bind to the same parameter and the solver moves whatever is free.

Syntax sketch (finalized during the M0 spike; semantic commitments above are fixed):

```abl
walltype ext_2x6 { thickness: 6 1/2" }        % assembly catalog; v1 = name + thickness
walltype int_2x4 { thickness: 4 1/2" }

param kitchen.width = 11'-6"  [measured 2026-07-05]
param kitchen.depth = 12'-0"  [approximated]

room kitchen : rect(kitchen.width, kitchen.depth) {
  share west = living.east          % ONE wall bounding two rooms
  walls: int_2x4  exterior north: ext_2x6
  height: 8'-0" [approximated]
}

door kitchen_living {
  in: living.east                   % hosted once; both rooms see it
  at: 2'-0" from living.ne          % anchored to a named junction
  size: 2'-8" x 6'-8"
}

meas diag_check: dist(kitchen.ne, kitchen.sw) = 16'-7 1/4" [measured]
```

A concept is a layer file:

```abl
layer galley : asbuilt

set kitchen.width = 10'-0" [designed]
delete door kitchen_living
door kitchen_living_2 { in: living.east, at: 4'-0" from living.ne, size: 3'-0" x 6'-8" }
```

## Provenance

Four states, distinct rendering in every view:

- `measured` — tape-measure truth. Hard constraint. A drag can never change it (lock feedback instead).
- `approximated` — a guess standing in for reality. Soft constraint (strong weight). The **Assumption Audit** panel = the list of these in the as-built lineage: your what-to-measure-next list.
- `designed` — intent, not reality. What concepts mostly contain. Keeps "the concept says 14'" cleanly distinct from "someone measured 14'".
- `drawn` — sketch positions (`~(x,y)` on junctions): weakest constraint, a regularizer so under-constrained plans stay where you put them. Under-constrained is the normal, healthy state.

**Provenance propagates** through derivation: a wall length bound to an approximated parameter *displays* as approximated; the audit reports root causes, not symptoms.

## The solver

Weighted least squares / Gauss-Newton over junction coordinates + free parameters. Distances, angles, parallelism, colinearity, linear parameter expressions, and `rectilinear ns.*` — a blanket axis-alignment constraint over a namespace, defeasible per wall — as the workhorse default. House-scale (hundreds of variables) — trivially fast. Rectilinear-dominant plans converge instantly; angles are supported from day one because trapezoids and out-of-square reality require them.

**Loop closure is the general mechanism linking dimensions causally** (the original kitchen north/south question): around any wall loop, axis runs sum to zero. Measure all but one span on an axis and the last derives (provenance propagated from inputs); measure all of them and any disagreement surfaces as a contradiction *set* ({width, south_width, jog}: pick which demotes to approximated, or accept out-of-square). No special-cased opposite-wall rules.

Diagnostics, never silent failure:

- **Contradiction** (over-constrained): conflicting hard constraints identified as a *set* and surfaced — "north measured 12'-0", south measured 11'-11", rect default says equal: pick a winner, average, or relax to out-of-square (angles absorb it)." That is exactly the field reality: the as-built is never square; the *concept* is where rectangular defaults belong.
- **Under-constrained**: fine; geometry rests on drawn positions.

## Branching

- A branch = one `.abl` layer file with `layer <name> : <parent>`. Resolution: merge layers bottom-up with name-shadowing and tombstones, statically check references, then solve. **Live inheritance** — concepts always see the parent's tip.
- **Conflict taxonomy** (per-concept review queue; decisions recorded in the layer):
  1. **Orphaned reference** — concept constrains or hosts on something deleted upstream → keep-as-new / drop / re-target.
  2. **Contradiction** — merged hard constraints disagree (solver residual set) → pick winner.
  3. **Masked correction** — base changed a value the concept shadows → informational flag: keep concept's value / adopt base / convert to relative expression (`= kitchen.width - 1'-6"`).
  4. **Geometric interference** — the merged layers are individually valid but physically impossible together (base adds a window where a concept's partition T-joins; walls overlap) → shift / re-host / accept-with-note. Requires an interference pass after solve, not just reference and constraint checks.
- **Re-parenting = rebase**: edit the `layer` header; re-merge, re-check, re-solve; cycles rejected. Relative expressions (`set x = parent_value ± delta` styles) are what make rebase *meaningful* — intent survives base corrections.

## Storage

```
myhouse.asbuilt/
  project.toml            # name, units, walltype catalog defaults
  asbuilt.abl             # the master layer
  concepts/
    galley.abl            # layer galley : asbuilt
    galley-v2.abl         # layer galley-v2 : galley
```

Plain text, one statement per line, **canonical formatting** (idempotent re-save, stable sort by name — legal because order is semantically irrelevant). Diffs beautifully in real git, which stays available on top for history/backup. No JSON-embedded program strings.

## Editing round-trip (the drag rule)

GUI edits write to **parameters and constraints, never to solved coordinates**:

1. Dragging geometry whose DOF binds to a free (`approximated`/`designed`) parameter → rewrites that parameter's value.
2. Dragging under-constrained geometry → rewrites junction `~` sketch positions.
3. `measured` values never change from a drag — the element resists and shows why (click the lock to demote to approximated if the measurement was wrong).
4. Every GUI action = a deterministic text edit to the current layer file. The text view and graphics view are always the same document.

## App architecture

Vite + React + TypeScript + Zustand + Vitest. Pure client-side, local-first, File System Access API for the project directory, localStorage autosave.

```
src/core/     framework-free: .abl parser/printer, layer merge + reference check,
              solver, provenance propagation, ft-in units, templates, conflicts
src/state/    store: project, current branch, selection, tool mode
src/ui2d/     SVG drafting view: walls w/ thickness, openings, dimension chains,
              provenance styling, snapping, drag per round-trip rules
src/ui3d/     Three.js: walls extruded from elevation profiles with opening holes
              (no CSG lib), slabs, OrbitControls, parent-branch ghost overlay
src/App.tsx   toolbar, branch switcher, 2D/3D/split, review queue, assumption audit
```

## Milestones — risk first

**M0 — Core spike (no UI).** Parser + layer merge + solver + write-back API as a library with tests. Prove: (a) rect room, change width, both walls move; (b) measure north ≠ south → contradiction surfaced → resolve by relaxing to trapezoid; (c) concept layer overrides width; base correction propagates; masked-correction flag fires; (d) "move junction to (x,y)" API returns the *text edit* it implies, per the drag rules; (e) canonical re-save is byte-identical. **If M0 works, everything else is carpentry. If it doesn't, we've spent no effort on scaffolding.**

**M1 — 2D editor.** App scaffold; render solved model in SVG (walls with thickness); draw/drag/delete walls with snapping (shared walls emerge by drawing against existing ones); open/save project dir; autosave.

**M2 — Dimensions & provenance UX.** Dimension chains along walls, diagonal check tool, ft-in entry parser (`12 3 1/2`, `12'3.5"`, `140.5"`), measured/approximated/designed styling, assumption audit panel, contradiction-resolution UI.

**M3 — Openings, assemblies, 3D.** Doors/windows hosted once with junction-anchored offsets; walltype catalog; fixtures as labeled boxes; Three.js view with cut openings; 2D/3D split; heights/sills editable in 3D.

**M4 — Branching.** Branch create/switch/re-parent UI; live inheritance; full conflict review queue; parent ghost overlay in both views; the killer demo: measure the as-built → concept updates, its designed changes intact, contradictions queued.

**M5 — Multi-level + field pass.** Levels with elevations, wall stacking alignment, stair-as-void v1 (second-story project); PNG export; a real example project (214 Maynard?) as living documentation.

**M6 — Hover previews.** Hovering anything that implies a change renders a ghost of the would-be result on whichever canvases are visible (2D and/or 3D), before committing. Architecture: every such control already produces a text-edit proposal; hover = run the proposal through a scratch merge+solve pipeline (never touching real files/undo) and render the resulting geometry as a preview overlay, diffed against current (moved walls ghosted at the new position, removed ones marked). Primary driver: hovering a proposed resolution in the review queue (keep/adopt/demote/relax/remove) shows what accepting it would do. Also applies to: suspect-row actions, re-parent candidates in the parent selector (preview the rebased model), pending inspector field edits before Enter, and delete buttons. Companion (read-only, no scratch solve): hovering any dimension or property in the inspector highlights the geometry it refers to on the canvas — hover `k.width` → that dimension chain/wall pair lights up; hover an opening's offset → the offset span from its anchor lights up. Needs: debounce + solve-cancellation so hover stays cheap; a distinct "hypothetical" visual treatment that can't be confused with the parent ghost overlay from M4.

**M7 — Face-referenced measurement.** *Gates the real field pass (214 Maynard): today every tape read is recorded as centerline, which is wrong by a full wall thickness for a room taped inside-to-inside.* A wall run has three measurable dimensions — inner (ends at the inside of each corner), outer, and centerline — related by `M = C + eA·½tA + eB·½tB` (e = −1 inner / +1 outer per end; t = crossing wall's thickness there). The mixed inner/outer read equals centerline exactly only when the two end walls' thicknesses are equal; a wall that T's into another has only the near face reachable at that end (always −½t). Design:
- **Store the tape read verbatim with its reference**; centerline stays the canonical solver space, derived at resolve. `meas m1 : dist(k.sw, k.se) = 11'-6" [measured] { ref: inner }`, per-end form (`ref: inner, outer`) for mixed reads. Deterministic desugaring at plain L-corners and T-ends; ambiguous junctions (X) must be stated explicitly — general fallback is letting expressions reference `int_2x4.thickness`.
- **Never freeze the derived number.** Param promotion must not write `param = tape + correction [measured]` — that stores a "measured" value nobody measured with a thickness assumption baked in. Keep the observation in the meas (or attach the derivation), let the solver own centerline.
- **Thickness joins the provenance system**: `walltype int_2x4 { thickness: 4 1/2" [approximated] }`, thickness as a solver-visible target (hard when measured, soft otherwise). Consequences that then come free: derived grades weaken through thickness (measured tape × approximated thickness = approximated centerline, audit panel says measure the wall); with soft thickness, an inner read + an outer read across the same wall lets the solver **derive the wall's true thickness**.
- **Adjacent thickness change is NOT a standalone review event** — the face-referenced observation still holds exactly; the derived centerline just recomputes (live inheritance; masked-correction logic doesn't apply because nothing frozen went stale). It **queues only on collision**: when a thickness change makes two hard observations mutually unsatisfiable, the existing contradiction machinery fires and the **walltype joins the suspect list** ("these tapes disagree given int_2x4 = 4½ — correct a tape, or the wall isn't a 2×4") with the usual correct/demote/remove resolutions. The no-partner case surfaces via provenance (approximated thickness in the support set → audit list), not a queue item.
- UX: Measure tool asks inside/outside/centerline (inside default for room spans); `rect(w, d)` gets a `dims: inner` option (field reality: you tape room interiors); wall inspector shows all three dimensions with the actually-measured one flagged.

**M8 — UI parity for the text-only language.** Everything expressible in .abl should be creatable/editable in the GUI (still: every GUI action = a deterministic text edit). Gaps as of M5: level create/edit (elevation + provenance), a void tool (draw the stair opening on a level), a stack action (select two junctions across levels → `stack a on b`), walltype catalog editor (create, rename, thickness — provenance-aware after M7), `space` label placement/editing, `length()` binding creation/retarget. Triage per item: some may stay deliberately text-first, but nothing needed mid-field-pass should require a text editor.

## Verification

- Vitest on core: everything in M0's list, plus ft-in round-trips, provenance propagation, tombstones, re-parent cycles rejected, orphan detection.
- Playwright E2E (M1+): draw kitchen → branch concept → move a wall in concept → measure base width → concept geometry corrected, concept's move preserved, no conflicts → add contradicting concept measurement → review queue shows it.
- Manual: model a real room of the actual house each milestone — the house is the test suite.

## Deliberately deferred

Roof massing, DXF/sheets, general angled dimension chains beyond solver basics, template library beyond `rect`, explicit pinning of concepts (journal design supports adding it later).

## Git

Feature branch off `main`; small commits per milestone; push when asked.
