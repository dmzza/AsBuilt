import {
  stmtKey,
  type AxisStmt,
  type Expr,
  type JunctionStmt,
  type LengthStmt,
  type ParamStmt,
  type ParsedLayer,
  type RoomRectStmt,
  type SetStmt,
  type SpaceStmt,
  type Stmt,
  type WallStmt,
} from "./ast";
import { formatLength, type S64 } from "./units";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code:
    | "cycle"
    | "unknown-parent"
    | "set-missing-base"
    | "set-no-was"
    | "masked-correction"
    | "unknown-ref"
    | "room-needs-walltype"
    | "delete-missing";
  message: string;
  /** Statement key this diagnostic attaches to, when applicable. */
  key?: string;
  data?: Record<string, unknown>;
}

/** An effective statement after merge: where it came from and how. */
export interface EffStmt {
  stmt: Stmt;
  /** Layer whose statement won the key. */
  layer: string;
  /** Name of the room/rectilinear statement this was expanded from, if any. */
  expandedFrom?: string;
}

export interface Resolved {
  /** Effective statements by shadowing key. */
  effective: Map<string, EffStmt>;
  /** Branch chain, root first. */
  chain: string[];
  diagnostics: Diagnostic[];
}

/** Effective param view: value/prov after any `set` override. */
export interface EffParam {
  name: string;
  value: S64;
  prov: ParamStmt["prov"];
  /** Layer owning the effective statement (the set's layer if overridden). */
  layer: string;
  /** The winning statement (param or set) for text edits. */
  stmt: ParamStmt | SetStmt;
}

export function evalExpr(expr: Expr, params: Map<string, S64>): S64 | null {
  let total = 0;
  for (const t of expr.terms) {
    if (t.kind === "lit") {
      total += t.sign * t.value;
    } else {
      const v = params.get(t.name);
      if (v === undefined) return null;
      total += t.sign * v;
    }
  }
  return total;
}

export function exprRefs(expr: Expr): string[] {
  return expr.terms.flatMap((t) => (t.kind === "ref" ? [t.name] : []));
}

function expandRoom(
  room: RoomRectStmt,
  layer: string,
  paramValues: Map<string, S64>,
  defaultWallType: string | null,
  diagnostics: Diagnostic[],
): Map<string, EffStmt> {
  const out = new Map<string, EffStmt>();
  const r = room.name;
  const w = evalExpr(room.width, paramValues) ?? 12 * 64 * 12;
  const d = evalExpr(room.depth, paramValues) ?? 10 * 64 * 12;
  const ox = room.at?.x ?? 0;
  const oy = room.at?.y ?? 0;

  const wallType = room.walls ?? defaultWallType;
  if (wallType === null) {
    diagnostics.push({
      severity: "error",
      code: "room-needs-walltype",
      key: r,
      message: `room ${r}: no walls: type given and no unique walltype to default to`,
    });
    return out;
  }

  const j = (suffix: string, x: S64, y: S64): JunctionStmt => ({
    kind: "junction",
    name: `${r}.${suffix}`,
    sketch: { x, y },
    loc: room.loc,
    leadingComments: [],
  });
  const wall = (suffix: string, from: string, to: string): WallStmt => ({
    kind: "wall",
    name: `${r}.${suffix}`,
    from,
    to,
    wallType,
    loc: room.loc,
    leadingComments: [],
  });
  const len = (suffix: string, expr: Expr): LengthStmt => ({
    kind: "length",
    wall: `${r}.${suffix}`,
    expr,
    loc: room.loc,
    leadingComments: [],
  });
  const axis = (suffix: string, orient: "h" | "v"): AxisStmt => ({
    kind: "axis",
    name: `${r}.${suffix}.axis`,
    wall: `${r}.${suffix}`,
    orient,
    origin: r,
    loc: room.loc,
    leadingComments: [],
  });

  const stmts: Stmt[] = [
    j("sw", ox, oy),
    j("se", ox + w, oy),
    j("ne", ox + w, oy + d),
    j("nw", ox, oy + d),
    wall("south", `${r}.sw`, `${r}.se`),
    wall("east", `${r}.se`, `${r}.ne`),
    wall("north", `${r}.ne`, `${r}.nw`),
    wall("west", `${r}.nw`, `${r}.sw`),
    len("south", room.width),
    len("north", room.width),
    len("east", room.depth),
    len("west", room.depth),
    axis("south", "h"),
    axis("north", "h"),
    axis("east", "v"),
    axis("west", "v"),
    {
      kind: "space",
      name: `${r}.space`,
      at: { x: ox + Math.round(w / 2), y: oy + Math.round(d / 2) },
      loc: room.loc,
      leadingComments: [],
    } satisfies SpaceStmt,
  ];

  for (const s of stmts) {
    const key =
      s.kind === "axis"
        ? s.name
        : s.kind === "length"
          ? `${s.wall}.length`
          : (s as JunctionStmt | WallStmt | SpaceStmt).name;
    out.set(key, { stmt: s, layer, expandedFrom: r });
  }
  return out;
}

/**
 * Resolve a branch: merge its layer chain (root -> leaf) with name shadowing
 * and tombstones, expand templates/blankets, and check references.
 */
export function resolve(layers: Map<string, ParsedLayer>, branch: string): Resolved {
  const diagnostics: Diagnostic[] = [];

  // --- build chain, leaf -> root, then reverse
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = branch;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      diagnostics.push({
        severity: "error",
        code: "cycle",
        message: `layer cycle through "${cursor}"`,
      });
      return { effective: new Map(), chain: [], diagnostics };
    }
    seen.add(cursor);
    const layer: ParsedLayer | undefined = layers.get(cursor);
    if (layer === undefined) {
      diagnostics.push({
        severity: "error",
        code: "unknown-parent",
        message: `unknown layer "${cursor}"`,
      });
      return { effective: new Map(), chain: [], diagnostics };
    }
    chain.push(cursor);
    cursor = layer.header.parent;
  }
  chain.reverse();

  // --- pass 1: authored statements with shadowing + tombstones
  const effective = new Map<string, EffStmt>();
  const deleted = new Set<string>();

  for (const layerName of chain) {
    const layer = layers.get(layerName)!;
    for (const s of layer.stmts) {
      if (s.kind === "delete") {
        if (!effective.has(s.target) && !isExpandableKey(s.target)) {
          // May target an expanded statement; verified after expansion.
          deleted.add(s.target);
        } else {
          effective.delete(s.target);
          deleted.add(s.target);
        }
        continue;
      }
      if (s.kind === "set") {
        const base = effective.get(s.name);
        if (base === undefined || (base.stmt.kind !== "param" && base.stmt.kind !== "set")) {
          diagnostics.push({
            severity: "error",
            code: "set-missing-base",
            key: s.name,
            message: `set ${s.name}: no param of that name exists in ancestor layers`,
          });
          continue;
        }
        const baseStmt = base.stmt;
        if (s.was === undefined) {
          diagnostics.push({
            severity: "info",
            code: "set-no-was",
            key: s.name,
            message: `set ${s.name}: no (was ...) recorded; masked corrections cannot be detected`,
          });
        } else if (baseStmt.value !== s.was) {
          diagnostics.push({
            severity: "warning",
            code: "masked-correction",
            key: s.name,
            message:
              `masked correction on ${s.name}: base now ${formatLength(baseStmt.value)}, ` +
              `override recorded (was ${formatLength(s.was)}) and holds ${formatLength(s.value)}`,
            data: { base: baseStmt.value, was: s.was, override: s.value },
          });
        }
        effective.set(s.name, { stmt: s, layer: layerName });
        deleted.delete(s.name);
        continue;
      }
      const key = stmtKey(s);
      if (key !== null) {
        effective.set(key, { stmt: s, layer: layerName });
        deleted.delete(key);
      }
    }
  }

  // --- collect param values for expansion seeds
  const paramValues = new Map<string, S64>();
  for (const [key, eff] of effective) {
    if (eff.stmt.kind === "param" || eff.stmt.kind === "set") {
      paramValues.set(key, eff.stmt.value);
    }
  }

  // --- default walltype: unique one, if any
  const wallTypes = [...effective.values()].filter((e) => e.stmt.kind === "walltype");
  const defaultWallType =
    wallTypes.length === 1 ? (wallTypes[0]!.stmt as { name: string }).name : null;

  // --- pass 2: room template expansion (authored keys win; tombstones hold)
  for (const [, eff] of [...effective]) {
    if (eff.stmt.kind !== "room") continue;
    const expanded = expandRoom(
      eff.stmt,
      eff.layer,
      paramValues,
      defaultWallType,
      diagnostics,
    );
    for (const [key, e] of expanded) {
      if (effective.has(key) || deleted.has(key)) continue; // pierced or tombstoned
      effective.set(key, e);
    }
  }

  // --- pass 3: rectilinear blanket expansion
  for (const [, eff] of [...effective]) {
    if (eff.stmt.kind !== "rectilinear") continue;
    const ns = eff.stmt.ns;
    for (const [wallKey, wallEff] of effective) {
      if (wallEff.stmt.kind !== "wall") continue;
      if (!wallKey.startsWith(`${ns}.`)) continue;
      const axisKey = `${wallKey}.axis`;
      if (effective.has(axisKey) || deleted.has(axisKey)) continue;
      const wall = wallEff.stmt;
      const a = effective.get(wall.from);
      const b = effective.get(wall.to);
      if (a?.stmt.kind !== "junction" || b?.stmt.kind !== "junction") continue;
      const dx = Math.abs(b.stmt.sketch.x - a.stmt.sketch.x);
      const dy = Math.abs(b.stmt.sketch.y - a.stmt.sketch.y);
      effective.set(axisKey, {
        stmt: {
          kind: "axis",
          name: axisKey,
          wall: wallKey,
          orient: dx >= dy ? "h" : "v",
          origin: `${ns}.rectilinear`,
          loc: eff.stmt.loc,
          leadingComments: [],
        },
        layer: eff.layer,
        expandedFrom: `${ns}.rectilinear`,
      });
    }
  }

  // --- reference checks
  const has = (name: string, kinds: string[]): boolean => {
    const e = effective.get(name);
    return e !== undefined && kinds.includes(e.stmt.kind);
  };
  const badRef = (from: string, ref: string, expected: string): void => {
    diagnostics.push({
      severity: "error",
      code: "unknown-ref",
      key: from,
      message: `${from}: unknown ${expected} "${ref}"`,
    });
  };

  for (const [key, eff] of effective) {
    const s = eff.stmt;
    switch (s.kind) {
      case "wall":
        if (!has(s.from, ["junction"])) badRef(key, s.from, "junction");
        if (!has(s.to, ["junction"])) badRef(key, s.to, "junction");
        if (!has(s.wallType, ["walltype"])) badRef(key, s.wallType, "walltype");
        break;
      case "length":
        if (!has(s.wall, ["wall"])) badRef(key, s.wall, "wall");
        for (const ref of exprRefs(s.expr)) {
          if (!has(ref, ["param", "set"])) badRef(key, ref, "param");
        }
        break;
      case "meas":
        if (!has(s.a, ["junction"])) badRef(key, s.a, "junction");
        if (!has(s.b, ["junction"])) badRef(key, s.b, "junction");
        break;
      case "opening": {
        const wallEff = effective.get(s.wall);
        if (wallEff?.stmt.kind !== "wall") {
          badRef(key, s.wall, "wall");
        } else if (s.anchor !== wallEff.stmt.from && s.anchor !== wallEff.stmt.to) {
          diagnostics.push({
            severity: "error",
            code: "unknown-ref",
            key,
            message: `${key}: anchor "${s.anchor}" is not an endpoint of ${s.wall}`,
          });
        }
        for (const ref of exprRefs(s.offset)) {
          if (!has(ref, ["param", "set"])) badRef(key, ref, "param");
        }
        break;
      }
      case "room":
        for (const ref of [...exprRefs(s.width), ...exprRefs(s.depth)]) {
          if (!has(ref, ["param", "set"])) badRef(key, ref, "param");
        }
        break;
      case "axis":
        if (!has(s.wall, ["wall"])) badRef(key, s.wall, "wall");
        break;
      default:
        break;
    }
  }

  return { effective, chain, diagnostics };
}

/** Keys that might only exist after expansion (contain .axis/.length/.space). */
function isExpandableKey(key: string): boolean {
  return key.endsWith(".axis") || key.endsWith(".length") || key.endsWith(".space");
}

/** Convenience: effective params with their winning statements. */
export function effectiveParams(resolved: Resolved): Map<string, EffParam> {
  const out = new Map<string, EffParam>();
  for (const [key, eff] of resolved.effective) {
    if (eff.stmt.kind === "param" || eff.stmt.kind === "set") {
      out.set(key, {
        name: key,
        value: eff.stmt.value,
        prov: eff.stmt.prov,
        layer: eff.layer,
        stmt: eff.stmt,
      });
    }
  }
  return out;
}
