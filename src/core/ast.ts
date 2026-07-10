import type { S64 } from "./units";

/** Provenance of an authored value. "drawn" is implicit on junction sketches. */
export type Provenance = "measured" | "approximated" | "designed";

/** Display grade of a derived value = weakest provenance in its support set. */
export type Grade = Provenance | "drawn";

export interface SrcLoc {
  file: string;
  /** 1-indexed line in the layer file. */
  line: number;
}

/** A signed term of a linear length expression: `kitchen.width - 1'-6"`. */
export type ExprTerm =
  | { sign: 1 | -1; kind: "ref"; name: string }
  | { sign: 1 | -1; kind: "lit"; value: S64 };

export interface Expr {
  terms: ExprTerm[];
}

export interface Point {
  x: S64;
  y: S64;
}

interface StmtBase {
  loc: SrcLoc;
  /** Full-line comments immediately above this statement (preserved on re-save). */
  leadingComments: string[];
}

export interface LayerHeader extends StmtBase {
  kind: "layer";
  name: string;
  parent: string | null;
}

export interface WallTypeStmt extends StmtBase {
  kind: "walltype";
  name: string;
  thickness: S64;
}

export interface ParamStmt extends StmtBase {
  kind: "param";
  name: string;
  value: S64;
  prov: Provenance;
  date?: string;
}

/** Override of an ancestor's param. `was` records the shadowed value at override time. */
export interface SetStmt extends StmtBase {
  kind: "set";
  name: string;
  value: S64;
  prov: Provenance;
  date?: string;
  was?: S64;
}

export interface JunctionStmt extends StmtBase {
  kind: "junction";
  name: string;
  sketch: Point;
}

export interface WallStmt extends StmtBase {
  kind: "wall";
  name: string;
  from: string;
  to: string;
  wallType: string;
}

/** `room k : rect(w, d) { at: ~(x, y), walls: t, height: h [prov] }` — a template, expanded at resolve. */
export interface RoomRectStmt extends StmtBase {
  kind: "room";
  name: string;
  width: Expr;
  depth: Expr;
  /** SW corner sketch origin; defaults to (0,0). */
  at?: Point;
  walls?: string;
  height?: { value: S64; prov: Provenance };
}

/** `rectilinear ns.*` — axis-align every wall in the namespace (defeasible per wall). */
export interface RectilinearStmt extends StmtBase {
  kind: "rectilinear";
  ns: string;
}

/** `length(wall) = expr` — statement key is `<wall>.length`. */
export interface LengthStmt extends StmtBase {
  kind: "length";
  wall: string;
  expr: Expr;
}

/**
 * `door d1 { in: k.north, at: 2'-0" from k.nw, size: 2'-8" x 6'-8" }`
 * `window w1 { in: k.north, at: 5'-0" from k.ne, size: 3'-0" x 3'-0", sill: 2'-6" }`
 * Hosted once in a wall; `at` is the along-wall offset from an endpoint
 * junction of that wall to the near jamb, so host corrections keep the
 * opening where it was meant relative to its anchor.
 */
export interface OpeningStmt extends StmtBase {
  kind: "opening";
  opKind: "door" | "window";
  name: string;
  wall: string;
  /** Endpoint junction of `wall` the offset is measured from. */
  anchor: string;
  offset: Expr;
  width: S64;
  height: S64;
  sill?: S64;
}

/** `fixture f1 { kind: fridge, at: ~(x, y), size: 3'-0" x 2'-6", rot: 90 }` */
export interface FixtureStmt extends StmtBase {
  kind: "fixture";
  name: string;
  fixKind: string;
  at: Point;
  w: S64;
  d: S64;
  rot: 0 | 90 | 180 | 270;
}

/** `meas name : dist(a, b) = len [measured ...]` */
export interface MeasStmt extends StmtBase {
  kind: "meas";
  name: string;
  a: string;
  b: string;
  value: S64;
  date?: string;
}

export interface SpaceStmt extends StmtBase {
  kind: "space";
  name: string;
  at: Point;
}

/**
 * `level up.* { elev: 9'-1" [approximated] }` — everything keyed under `up.`
 * sits at that elevation. Keys matching no level statement are the ground
 * level at 0". Key is `<ns>.level`, so a concept re-authoring the line
 * shadows the elevation.
 */
export interface LevelStmt extends StmtBase {
  kind: "level";
  ns: string;
  elev: S64;
  prov: Provenance;
}

/**
 * `stack up.master.sw on lv.sw` — junction `a` bears directly over junction
 * `b`: hard plan-coincidence (equal x, equal y) across levels.
 */
export interface StackStmt extends StmtBase {
  kind: "stack";
  /** `<a>.stack` */
  name: string;
  a: string;
  b: string;
}

/**
 * `void up.stairwell { at: ~(x, y), size: 3'-0" x 10'-0" }` — a floor
 * opening (stairwell) cut from the slab of its key's level.
 */
export interface VoidStmt extends StmtBase {
  kind: "void";
  name: string;
  at: Point;
  w: S64;
  d: S64;
}

export interface DeleteStmt extends StmtBase {
  kind: "delete";
  target: string;
}

/**
 * `axis <wall> h|v` — constrain a wall to an axis. Authored for drawn walls;
 * also produced by rect/rectilinear expansion (with `origin` set).
 */
export interface AxisStmt extends StmtBase {
  kind: "axis";
  /** `<wall>.axis` */
  name: string;
  wall: string;
  orient: "h" | "v";
  /** Statement that produced this via expansion, for diagnostics. */
  origin?: string;
}

export type Stmt =
  | LayerHeader
  | WallTypeStmt
  | ParamStmt
  | SetStmt
  | JunctionStmt
  | WallStmt
  | OpeningStmt
  | FixtureStmt
  | RoomRectStmt
  | RectilinearStmt
  | AxisStmt
  | LengthStmt
  | MeasStmt
  | SpaceStmt
  | LevelStmt
  | StackStmt
  | VoidStmt
  | DeleteStmt;

/**
 * Shadowing key of a statement. Two statements with the same key across a
 * layer chain shadow (leaf wins); deletes tombstone keys.
 */
export function stmtKey(s: Stmt): string | null {
  switch (s.kind) {
    case "layer":
      return null;
    case "walltype":
    case "param":
    case "junction":
    case "wall":
    case "opening":
    case "fixture":
    case "room":
    case "meas":
    case "space":
    case "void":
      return s.name;
    case "set":
      return s.name; // shadows the param of the same name
    case "axis":
    case "stack":
      return s.name;
    case "rectilinear":
      return `${s.ns}.rectilinear`;
    case "level":
      return `${s.ns}.level`;
    case "length":
      return `${s.wall}.length`;
    case "delete":
      return null; // consumes s.target instead
  }
}

export interface ParsedLayer {
  header: LayerHeader;
  stmts: Stmt[];
  /** Comments trailing at end of file. */
  trailingComments: string[];
}

export class AblParseError extends Error {
  constructor(
    public readonly loc: SrcLoc,
    detail: string,
  ) {
    super(`${loc.file}:${loc.line}: ${detail}`);
    this.name = "AblParseError";
  }
}
