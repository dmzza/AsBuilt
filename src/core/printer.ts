import type { Expr, ParsedLayer, Point, Stmt } from "./ast";
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
  "param",
  "set",
  "junction",
  "wall",
  "room",
  "rectilinear",
  "axis",
  "length",
  "meas",
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
    case "walltype":
      return `walltype ${s.name} { thickness: ${formatLength(s.thickness)} }`;
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
      const block = opts.length > 0 ? ` { ${opts.join(", ")} }` : "";
      return `room ${s.name} : rect(${printExpr(s.width)}, ${printExpr(s.depth)})${block}`;
    }
    case "rectilinear":
      return `rectilinear ${s.ns}.*`;
    case "axis":
      return `axis ${s.wall} ${s.orient}`;
    case "length":
      return `length(${s.wall}) = ${printExpr(s.expr)}`;
    case "meas": {
      const prov = printProv("measured", s.date);
      return `meas ${s.name} : dist(${s.a}, ${s.b}) = ${formatLength(s.value)} ${prov}`;
    }
    case "space":
      return `space ${s.name} { at: ${printPoint(s.at)} }`;
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
    case "layer":
      return "";
    default:
      return s.name;
  }
}
