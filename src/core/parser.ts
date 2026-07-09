import {
  AblParseError,
  type Expr,
  type ExprTerm,
  type LayerHeader,
  type ParsedLayer,
  type Point,
  type Provenance,
  type SrcLoc,
  type Stmt,
} from "./ast";
import { parseLength, type S64 } from "./units";

const NAME = String.raw`[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*`;
const NAME_RE = new RegExp(`^${NAME}$`);

// A length literal never contains commas, parens, brackets or %.
const LEN = String.raw`[^,()\[\]{}%:]+`;

const PROV_RE = /^\[(measured|approximated|designed)(?:\s+(\d{4}-\d{2}-\d{2}))?\]$/;

interface Line {
  raw: string;
  body: string; // trimmed, comment stripped
  comment: string | null; // trailing comment text incl. leading %
  loc: SrcLoc;
}

function splitComment(raw: string): { body: string; comment: string | null } {
  const idx = raw.indexOf("%");
  if (idx === -1) return { body: raw.trim(), comment: null };
  return { body: raw.slice(0, idx).trim(), comment: raw.slice(idx).trimEnd() };
}

function parseProv(
  bracket: string | undefined,
  loc: SrcLoc,
): { prov: Provenance; date?: string } {
  if (bracket === undefined) return { prov: "approximated" };
  const m = PROV_RE.exec(bracket.trim());
  if (!m) throw new AblParseError(loc, `bad provenance "${bracket.trim()}"`);
  return { prov: m[1] as Provenance, date: m[2] };
}

function parseLen(text: string, loc: SrcLoc): S64 {
  try {
    return parseLength(text.trim());
  } catch (e) {
    throw new AblParseError(loc, (e as Error).message);
  }
}

function parseName(text: string, loc: SrcLoc): string {
  const t = text.trim();
  if (!NAME_RE.test(t)) throw new AblParseError(loc, `bad name "${t}"`);
  return t;
}

function parsePoint(text: string, loc: SrcLoc): Point {
  // ~(x, y)
  const m = /^~\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)$/.exec(text.trim());
  if (!m) throw new AblParseError(loc, `bad point "${text.trim()}", expected ~(x, y)`);
  return { x: parseLen(m[1]!, loc), y: parseLen(m[2]!, loc) };
}

/** Linear length expression: `k.width`, `12'-0"`, `k.width - 1'-6" + k.trim`. */
export function parseExpr(text: string, loc: SrcLoc): Expr {
  // Split on +/- that act as operators. Length literals contain '-' only
  // inside like 12'-3": always preceded by '. We split on +/- preceded by
  // whitespace, which the canonical form guarantees for operators.
  const src = text.trim();
  const terms: ExprTerm[] = [];
  const tokenRe = /\s+([+-])\s+/g;
  let last = 0;
  const pieces: { text: string; sign: 1 | -1 }[] = [];
  let curSign: 1 | -1 = 1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src)) !== null) {
    pieces.push({ text: src.slice(last, m.index), sign: curSign });
    curSign = m[1] === "-" ? -1 : 1;
    last = tokenRe.lastIndex;
  }
  pieces.push({ text: src.slice(last), sign: curSign });

  for (const piece of pieces) {
    const t = piece.text.trim();
    if (t.length === 0) throw new AblParseError(loc, `empty term in expression "${src}"`);
    if (NAME_RE.test(t)) {
      terms.push({ sign: piece.sign, kind: "ref", name: t });
    } else {
      terms.push({ sign: piece.sign, kind: "lit", value: parseLen(t, loc) });
    }
  }
  return { terms };
}

/** Parse `{ key: value, key: value }` with values free of commas/braces. */
function parseBlock(text: string, loc: SrcLoc): Map<string, string> {
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) {
    throw new AblParseError(loc, `expected { ... } block, got "${t}"`);
  }
  const inner = t.slice(1, -1).trim();
  const out = new Map<string, string>();
  if (inner.length === 0) return out;
  // Split on commas not inside parens (points contain commas inside ~(...)).
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  for (const part of parts) {
    const ci = part.indexOf(":");
    if (ci === -1) throw new AblParseError(loc, `bad block entry "${part.trim()}"`);
    const key = part.slice(0, ci).trim();
    const value = part.slice(ci + 1).trim();
    if (out.has(key)) throw new AblParseError(loc, `duplicate block key "${key}"`);
    out.set(key, value);
  }
  return out;
}

function requireKeys(
  block: Map<string, string>,
  required: string[],
  optional: string[],
  loc: SrcLoc,
): void {
  for (const k of required) {
    if (!block.has(k)) throw new AblParseError(loc, `missing "${k}:" in block`);
  }
  for (const k of block.keys()) {
    if (!required.includes(k) && !optional.includes(k)) {
      throw new AblParseError(loc, `unknown block key "${k}"`);
    }
  }
}

const LAYER_RE = new RegExp(`^layer\\s+(${NAME})(?:\\s*:\\s*(${NAME}))?$`);
const WALLTYPE_RE = new RegExp(`^walltype\\s+(${NAME})\\s*(\\{.*\\})$`);
const PARAM_RE = new RegExp(`^param\\s+(${NAME})\\s*=\\s*(${LEN}?)(\\[[^\\]]*\\])?$`);
const SET_RE = new RegExp(
  `^set\\s+(${NAME})\\s*=\\s*(${LEN}?)(\\[[^\\]]*\\])?(?:\\s*\\(was\\s+([^)]+)\\))?$`,
);
const JUNCTION_RE = new RegExp(`^junction\\s+(${NAME})\\s+(~\\(.*\\))$`);
const WALL_RE = new RegExp(`^wall\\s+(${NAME})\\s*(\\{.*\\})$`);
const ROOM_RE = new RegExp(`^room\\s+(${NAME})\\s*:\\s*rect\\((.*)\\)\\s*(\\{.*\\})?$`);
const RECTILINEAR_RE = new RegExp(`^rectilinear\\s+(${NAME})\\.\\*$`);
const AXIS_RE = new RegExp(`^axis\\s+(${NAME})\\s+(h|v)$`);
const OPENING_RE = new RegExp(`^(door|window)\\s+(${NAME})\\s*(\\{.*\\})$`);
const FIXTURE_RE = new RegExp(`^fixture\\s+(${NAME})\\s*(\\{.*\\})$`);

/** `<expr> from <junction>` */
function parseAt(text: string, loc: SrcLoc): { offset: Expr; anchor: string } {
  const idx = text.lastIndexOf(" from ");
  if (idx === -1) throw new AblParseError(loc, `at: expected "<offset> from <junction>"`);
  return {
    offset: parseExpr(text.slice(0, idx), loc),
    anchor: parseName(text.slice(idx + " from ".length), loc),
  };
}

/** `<len> x <len>` */
function parseSize(text: string, loc: SrcLoc): { w: S64; h: S64 } {
  const parts = text.split(/\s+x\s+/);
  if (parts.length !== 2) throw new AblParseError(loc, `size: expected "<len> x <len>"`);
  return { w: parseLen(parts[0]!, loc), h: parseLen(parts[1]!, loc) };
}
const LENGTH_RE = new RegExp(`^length\\(\\s*(${NAME})\\s*\\)\\s*=\\s*(.+)$`);
const MEAS_RE = new RegExp(
  `^meas\\s+(${NAME})\\s*:\\s*dist\\(\\s*(${NAME})\\s*,\\s*(${NAME})\\s*\\)\\s*=\\s*(${LEN}?)(\\[[^\\]]*\\])?$`,
);
const SPACE_RE = new RegExp(`^space\\s+(${NAME})\\s*(\\{.*\\})$`);
const DELETE_RE = new RegExp(`^delete\\s+(${NAME})$`);

function parseStmtLine(line: Line, pendingComments: string[]): Stmt {
  const { body, loc } = line;
  const leadingComments = [...pendingComments];
  let m: RegExpExecArray | null;

  if ((m = LAYER_RE.exec(body))) {
    return { kind: "layer", name: m[1]!, parent: m[2] ?? null, loc, leadingComments };
  }

  if ((m = WALLTYPE_RE.exec(body))) {
    const block = parseBlock(m[2]!, loc);
    requireKeys(block, ["thickness"], [], loc);
    return {
      kind: "walltype",
      name: m[1]!,
      thickness: parseLen(block.get("thickness")!, loc),
      loc,
      leadingComments,
    };
  }

  if ((m = PARAM_RE.exec(body))) {
    const { prov, date } = parseProv(m[3], loc);
    return {
      kind: "param",
      name: m[1]!,
      value: parseLen(m[2]!, loc),
      prov,
      date,
      loc,
      leadingComments,
    };
  }

  if ((m = SET_RE.exec(body))) {
    const { prov, date } = parseProv(m[3], loc);
    return {
      kind: "set",
      name: m[1]!,
      value: parseLen(m[2]!, loc),
      prov,
      date,
      was: m[4] !== undefined ? parseLen(m[4], loc) : undefined,
      loc,
      leadingComments,
    };
  }

  if ((m = JUNCTION_RE.exec(body))) {
    return {
      kind: "junction",
      name: m[1]!,
      sketch: parsePoint(m[2]!, loc),
      loc,
      leadingComments,
    };
  }

  if ((m = WALL_RE.exec(body))) {
    const block = parseBlock(m[2]!, loc);
    requireKeys(block, ["from", "to", "type"], [], loc);
    return {
      kind: "wall",
      name: m[1]!,
      from: parseName(block.get("from")!, loc),
      to: parseName(block.get("to")!, loc),
      wallType: parseName(block.get("type")!, loc),
      loc,
      leadingComments,
    };
  }

  if ((m = ROOM_RE.exec(body))) {
    // rect args: two exprs split on top-level comma
    const args = m[2]!.split(",");
    if (args.length !== 2) throw new AblParseError(loc, `rect() takes (width, depth)`);
    const block = m[3] !== undefined ? parseBlock(m[3], loc) : new Map<string, string>();
    requireKeys(block, [], ["at", "walls", "height"], loc);
    let height: { value: S64; prov: Provenance } | undefined;
    const heightText = block.get("height");
    if (heightText !== undefined) {
      const hm = /^(.*?)(\[[^\]]*\])?$/.exec(heightText.trim())!;
      const { prov } = parseProv(hm[2], loc);
      height = { value: parseLen(hm[1]!, loc), prov };
    }
    return {
      kind: "room",
      name: m[1]!,
      width: parseExpr(args[0]!, loc),
      depth: parseExpr(args[1]!, loc),
      at: block.has("at") ? parsePoint(block.get("at")!, loc) : undefined,
      walls: block.has("walls") ? parseName(block.get("walls")!, loc) : undefined,
      height,
      loc,
      leadingComments,
    };
  }

  if ((m = RECTILINEAR_RE.exec(body))) {
    return { kind: "rectilinear", ns: m[1]!, loc, leadingComments };
  }

  if ((m = AXIS_RE.exec(body))) {
    return {
      kind: "axis",
      name: `${m[1]!}.axis`,
      wall: m[1]!,
      orient: m[2] as "h" | "v",
      loc,
      leadingComments,
    };
  }

  if ((m = OPENING_RE.exec(body))) {
    const block = parseBlock(m[3]!, loc);
    requireKeys(block, ["in", "at", "size"], ["sill"], loc);
    const { offset, anchor } = parseAt(block.get("at")!, loc);
    const { w, h } = parseSize(block.get("size")!, loc);
    return {
      kind: "opening",
      opKind: m[1] as "door" | "window",
      name: m[2]!,
      wall: parseName(block.get("in")!, loc),
      anchor,
      offset,
      width: w,
      height: h,
      sill: block.has("sill") ? parseLen(block.get("sill")!, loc) : undefined,
      loc,
      leadingComments,
    };
  }

  if ((m = FIXTURE_RE.exec(body))) {
    const block = parseBlock(m[2]!, loc);
    requireKeys(block, ["kind", "at", "size"], ["rot"], loc);
    const { w, h } = parseSize(block.get("size")!, loc);
    let rot: 0 | 90 | 180 | 270 = 0;
    if (block.has("rot")) {
      const r = parseInt(block.get("rot")!, 10);
      if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
        throw new AblParseError(loc, `rot must be 0, 90, 180, or 270`);
      }
      rot = r;
    }
    return {
      kind: "fixture",
      name: m[1]!,
      fixKind: parseName(block.get("kind")!, loc),
      at: parsePoint(block.get("at")!, loc),
      w,
      d: h,
      rot,
      loc,
      leadingComments,
    };
  }

  if ((m = LENGTH_RE.exec(body))) {
    return {
      kind: "length",
      wall: m[1]!,
      expr: parseExpr(m[2]!, loc),
      loc,
      leadingComments,
    };
  }

  if ((m = MEAS_RE.exec(body))) {
    const { prov, date } = parseProv(m[5], loc);
    if (prov !== "measured") {
      throw new AblParseError(loc, `meas statements are always [measured]`);
    }
    return {
      kind: "meas",
      name: m[1]!,
      a: m[2]!,
      b: m[3]!,
      value: parseLen(m[4]!, loc),
      date,
      loc,
      leadingComments,
    };
  }

  if ((m = SPACE_RE.exec(body))) {
    const block = parseBlock(m[2]!, loc);
    requireKeys(block, ["at"], [], loc);
    return {
      kind: "space",
      name: m[1]!,
      at: parsePoint(block.get("at")!, loc),
      loc,
      leadingComments,
    };
  }

  if ((m = DELETE_RE.exec(body))) {
    return { kind: "delete", target: m[1]!, loc, leadingComments };
  }

  throw new AblParseError(loc, `unrecognized statement "${body}"`);
}

/**
 * Parse one .abl layer file. The first statement must be the `layer` header.
 */
export function parseLayerFile(file: string, source: string): ParsedLayer {
  const lines: Line[] = source.split("\n").map((raw, i) => {
    const { body, comment } = splitComment(raw);
    return { raw, body, comment, loc: { file, line: i + 1 } };
  });

  let header: LayerHeader | null = null;
  const stmts: Stmt[] = [];
  let pendingComments: string[] = [];

  for (const line of lines) {
    if (line.body.length === 0) {
      if (line.comment !== null) pendingComments.push(line.comment);
      // blank line: comments above a blank line detach (file-level), keep simple: retain
      continue;
    }
    const stmt = parseStmtLine(line, pendingComments);
    pendingComments = [];
    if (stmt.kind === "layer") {
      if (header !== null) {
        throw new AblParseError(stmt.loc, "duplicate layer header");
      }
      if (stmts.length > 0) {
        throw new AblParseError(stmt.loc, "layer header must be the first statement");
      }
      header = stmt;
    } else {
      if (header === null) {
        throw new AblParseError(stmt.loc, "file must start with a layer header");
      }
      stmts.push(stmt);
    }
  }

  if (header === null) {
    throw new AblParseError({ file, line: 1 }, "missing layer header");
  }

  return { header, stmts, trailingComments: pendingComments };
}
