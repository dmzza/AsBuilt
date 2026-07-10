import type { Expr, ParsedLayer, Point, Stmt } from "./ast";
import { formatFaceRef } from "./faces";
import { formatLength } from "./units";

/**
 * Canonical printer. Properties:
 *  - one statement per line, header first
 *  - fixed kind order, name-sorted within each kind, blank line between kinds
 *  - lengths in canonical architectural form
 *  - leading comments travel with their statement
 * print(parse(print(x))) === print(x); a canonical file re-saves byte-identical.
 */

const KIND_ORDER: Stmt["kind"][] = [
  "walltype",
  "level",
  "param",
  "set",
  "junction",
  "wall",
  "opening",
  "room",
  "rectilinear",
  "axis",
  "length",
  "meas",
  "stack",
  "fixture",
  "void",
  "space",
  "delete",
];

export function printExpr(expr: Expr): string {
  let out = "";
  expr.terms.forEach((t, i) => {
    const body = t.kind === "ref" ? t.name : formatLength(t.value);
    if (i === 0) {
      if (t.sign === -1) throw new Error("canonical expressions start positive");
      out = body;
    } else {
      out += ` ${t.sign === 1 ? "+" : "-"} ${body}`;
    }
  });
  return out;
}

function printPoint(p: Point): string {
  return `~(${formatLength(p.x)}, ${formatLength(p.y)})`;
}

function printProv(prov: string, date?: string): string {
  return date !== undefined ? `[${prov} ${date}]` : `[${prov}]`;
}

export function printStmt(s: Stmt): string {
  switch (s.kind) {
    case "layer":
      return s.parent === null ? `layer ${s.name}` : `layer ${s.name} : ${s.parent}`;
    case "walltype": {
      // Omitting [approximated] keeps legacy files byte-stable; only print
      // non-default provenance (or a date) explicitly.
      const th =
        s.prov === "approximated" && s.date === undefined
          ? formatLength(s.thickness)
          : `${formatLength(s.thickness)} ${printProv(s.prov, s.date)}`;
      return `walltype ${s.name} { thickness: ${th} }`;
    }
    case "param":
      return `param ${s.name} = ${formatLength(s.value)} ${printProv(s.prov, s.date)}`;
    case "set": {
      const was = s.was !== undefined ? ` (was ${formatLength(s.was)})` : "";
      return `set ${s.name} = ${formatLength(s.value)} ${printProv(s.prov, s.date)}${was}`;
    }
    case "junction":
      return `junction ${s.name} ${printPoint(s.sketch)}`;
    case "wall":
      return `wall ${s.name} { from: ${s.from}, to: ${s.to}, type: ${s.wallType} }`;
    case "room": {
      const opts: string[] = [];
      if (s.at !== undefined) opts.push(`at: ${printPoint(s.at)}`);
      if (s.walls !== undefined) opts.push(`walls: ${s.walls}`);
      if (s.height !== undefined) {
        opts.push(`height: ${formatLength(s.height.value)} ${printProv(s.height.prov)}`);
      }
      if (s.dims !== undefined && s.dims !== "centerline") {
        opts.push(`dims: ${s.dims}`);
      }
      const block = opts.length > 0 ? ` { ${opts.join(", ")} }` : "";
      return `room ${s.name} : rect(${printExpr(s.width)}, ${printExpr(s.depth)})${block}`;
    }
    case "rectilinear":
      return `rectilinear ${s.ns}.*`;
    case "axis":
      return `axis ${s.wall} ${s.orient}`;
    case "opening": {
      const sill = s.sill !== undefined ? `, sill: ${formatLength(s.sill)}` : "";
      return (
        `${s.opKind} ${s.name} { in: ${s.wall}, at: ${printExpr(s.offset)} from ${s.anchor}, ` +
        `size: ${formatLength(s.width)} x ${formatLength(s.height)}${sill} }`
      );
    }
    case "fixture": {
      const rot = s.rot !== 0 ? `, rot: ${s.rot}` : "";
      return (
        `fixture ${s.name} { kind: ${s.fixKind}, at: ${printPoint(s.at)}, ` +
        `size: ${formatLength(s.w)} x ${formatLength(s.d)}${rot} }`
      );
    }
    case "length":
      return `length(${s.wall}) = ${printExpr(s.expr)}`;
    case "meas": {
      const prov = printProv("measured", s.date);
      const ref =
        s.ref !== undefined ? ` { ref: ${formatFaceRef(s.ref)} }` : "";
      return `meas ${s.name} : dist(${s.a}, ${s.b}) = ${formatLength(s.value)} ${prov}${ref}`;
    }
    case "space":
      return `space ${s.name} { at: ${printPoint(s.at)} }`;
    case "level":
      return `level ${s.ns}.* { elev: ${formatLength(s.elev)} ${printProv(s.prov)} }`;
    case "stack":
      return `stack ${s.a} on ${s.b}`;
    case "void":
      return (
        `void ${s.name} { at: ${printPoint(s.at)}, ` +
        `size: ${formatLength(s.w)} x ${formatLength(s.d)} }`
      );
    case "delete":
      return `delete ${s.target}`;
  }
}

export function printLayerFile(layer: ParsedLayer): string {
  const out: string[] = [];
  for (const c of layer.header.leadingComments) out.push(c);
  out.push(printStmt(layer.header));

  for (const kind of KIND_ORDER) {
    const group = layer.stmts
      .filter((s) => s.kind === kind)
      .sort((a, b) => sortName(a).localeCompare(sortName(b)));
    if (group.length === 0) continue;
    out.push("");
    for (const s of group) {
      for (const c of s.leadingComments) out.push(c);
      out.push(printStmt(s));
    }
  }

  for (const c of layer.trailingComments) out.push(c);
  out.push(""); // trailing newline
  return out.join("\n");
}

function sortName(s: Stmt): string {
  switch (s.kind) {
    case "length":
      return s.wall;
    case "axis":
      return s.wall;
    case "delete":
      return s.target;
    case "rectilinear":
      return s.ns;
    case "level":
      return s.ns;
    case "stack":
      return s.a;
    case "layer":
      return "";
    default:
      return s.name;
  }
}
