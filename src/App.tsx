import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import {
  allParams,
  allWallGrades,
  exprRefs,
  formatLength,
  junctionPos,
  levelViews,
  openingViews,
  parseLength,
  proposeDelete,
  proposeDropOrphan,
  proposeEditMeas,
  proposeMove,
  proposeReparent,
  proposeResolveMasked,
  proposeSetFixture,
  proposeSetOpening,
  proposeSetOpeningOffset,
  proposeSetParam,
  proposeSetWallType,
  wallView,
  type Diagnostic,
  type Grade,
  type Pipeline,
  type Provenance,
  type S64,
  type TextEdit,
} from "./core";
import { exportPlanPng, type TitleRow } from "./export";
import { fsAccessSupported } from "./persist";
import { useApp, type Tool } from "./state/store";
import { GRADE_COLORS, Plan2D } from "./ui2d/Plan2D";
import { View3D } from "./ui3d/View3D";

/** Provenance palette tuned for the dark chrome (sidebar, chips). */
const GRADE_DARK: Record<Grade, string> = {
  measured: "#82a8f8",
  designed: "#bb95f6",
  approximated: "#e2a350",
  drawn: "#a6a396",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmt16(inches: number): string {
  return formatLength(Math.round(inches * 16) * 4);
}

/** Wrap propose-then-run so proposer errors surface inline, not as toasts. */
function commitEdits(fn: () => TextEdit[]): string | null {
  try {
    useApp.getState().runEdits(fn());
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Hover handlers: while the pointer rests on the control, ghost `propose()`. */
function hoverPreview(propose: () => TextEdit[]): {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
} {
  const show = (): void => useApp.getState().previewEdits(propose);
  const hide = (): void => useApp.getState().clearPreview();
  return { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
}

/** Canvas keys a param drives directly: walls whose length binding cites it. */
function keysForParam(pipeline: Pipeline, name: string): string[] {
  const out: string[] = [];
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "length" && exprRefs(eff.stmt.expr).includes(name)) {
      out.push(key.slice(0, -".length".length));
    }
  }
  return out;
}

/** Suspect/support keys → canvas keys: meas and walls pass through, params map
 *  to the walls they bind, rect defaults map to their wall. */
function canvasKeysFor(pipeline: Pipeline, key: string): string[] {
  const eff = pipeline.resolved.effective.get(key);
  if (eff === undefined) return [];
  const k = eff.stmt.kind;
  if (k === "param" || k === "set") return keysForParam(pipeline, key);
  if (k === "length" || k === "axis") {
    const dot = key.lastIndexOf(".");
    return dot > 0 ? [key.slice(0, dot)] : [];
  }
  return [key];
}

/* ---------------------------------------------------------------- fields */

interface FieldProps {
  value: string;
  /** Parse + apply; return an error message to keep the field open. */
  onCommit: (raw: string) => string | null;
  /** Called on every keystroke while editing (hover-preview of pending edits). */
  onPending?: (raw: string) => void;
  placeholder?: string;
  title?: string;
}

/** An inline editable value: click to edit, Enter applies, Esc cancels. */
function Field({ value, onCommit, onPending, placeholder, title }: FieldProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        className="field"
        title={title ?? "Click to edit"}
        onClick={() => {
          setText(value);
          setError(null);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }
  return (
    <span className="field-edit">
      <input
        ref={inputRef}
        value={text}
        placeholder={placeholder ?? `e.g. 11'-8 1/2"`}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          onPending?.(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const err = onCommit(text);
            if (err !== null) setError(err);
            else setEditing(false);
          } else if (e.key === "Escape") {
            useApp.getState().clearPreview();
            setEditing(false);
          }
        }}
        onBlur={() => {
          useApp.getState().clearPreview();
          setEditing(false);
        }}
      />
      {error !== null && <span className="field-error">{error}</span>}
    </span>
  );
}

/** A length-valued Field: parses feet-inches, hands the S64 to `apply`.
 *  With `preview`, a pending (not yet committed) value ghosts on the canvas. */
function LengthField({
  inches,
  apply,
  preview,
  title,
}: {
  inches: number;
  apply: (v: S64) => string | null;
  preview?: (v: S64) => TextEdit[];
  title?: string;
}): JSX.Element {
  return (
    <Field
      value={fmt16(inches)}
      title={title}
      onPending={
        preview === undefined
          ? undefined
          : (raw) => {
              let v: S64;
              try {
                v = parseLength(raw);
              } catch {
                useApp.getState().clearPreview();
                return;
              }
              useApp.getState().previewEdits(() => preview(v));
            }
      }
      onCommit={(raw) => {
        let v: S64;
        try {
          v = parseLength(raw);
        } catch (e) {
          return (e as Error).message;
        }
        return apply(v);
      }}
    />
  );
}

/* ----------------------------------------------------------------- shell */

function Toast(): JSX.Element | null {
  const toast = useApp((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (toast === null) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  if (toast === null || !visible) return null;
  return <div className={`toast toast-${toast.kind}`}>{toast.message}</div>;
}

const TOOL_DEFS: { id: Tool; label: string; keyHint: string; icon: JSX.Element }[] = [
  {
    id: "select",
    label: "Select",
    keyHint: "V",
    icon: (
      <path d="M5.5 2.5 L14.5 9.8 L10.2 10.6 L12.4 15 L10.3 16 L8.2 11.7 L5.5 14.2 Z" />
    ),
  },
  {
    id: "wall",
    label: "Wall",
    keyHint: "W",
    icon: <path d="M2.5 7 H15.5 M2.5 11 H15.5 M6 7 L4.5 11 M10.5 7 L9 11 M15 7 L13.5 11" />,
  },
  {
    id: "measure",
    label: "Measure",
    keyHint: "M",
    icon: <path d="M3 9 H15 M3 5.5 V12.5 M15 5.5 V12.5 M6.5 7.5 V10.5 M9 7.5 V10.5 M11.5 7.5 V10.5" />,
  },
  {
    id: "door",
    label: "Door",
    keyHint: "D",
    icon: <path d="M4 15.5 V4 M4 4 A 11.5 11.5 0 0 1 15.5 15.5 M2 15.5 H16" />,
  },
  {
    id: "window",
    label: "Window",
    keyHint: "N",
    icon: <path d="M2.5 6.5 H15.5 V11.5 H2.5 Z M2.5 9 H15.5 M9 6.5 V11.5" />,
  },
  {
    id: "fixture",
    label: "Fixture",
    keyHint: "F",
    icon: <path d="M4 4.5 H14 V13.5 H4 Z M4 8 H14 M11 8 V13.5" />,
  },
];

function ToolRail(): JSX.Element {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  return (
    <div className="rail">
      {TOOL_DEFS.map((t) => (
        <button
          key={t.id}
          className={`rail-tool ${tool === t.id ? "active" : ""}`}
          title={`${t.label} (${t.keyHint})`}
          onClick={() => setTool(t.id)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <g
              fill={t.id === "select" ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              {t.icon}
            </g>
          </svg>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function ViewToggle(): JSX.Element {
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  return (
    <div className="seg">
      {(["2d", "3d", "split"] as const).map((m) => (
        <button
          key={m}
          className={viewMode === m ? "active" : ""}
          onClick={() => setViewMode(m)}
        >
          {m === "split" ? "Split" : m.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function SheetPicker(): JSX.Element {
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const setBranch = useApp((s) => s.setBranch);
  const newConcept = useApp((s) => s.newConcept);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const branches = useMemo(() => {
    if (project === null) return [];
    return [...project.layers.entries()].map(([n, l]) => ({
      name: n,
      parent: l.parsed.header.parent,
    }));
  }, [project]);

  return (
    <div className="sheet-picker">
      <label className="bar-label">Sheet</label>
      <select value={branch} onChange={(e) => setBranch(e.target.value)}>
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
            {b.parent !== null ? ` ← ${b.parent}` : ""}
          </option>
        ))}
      </select>
      <button title={`New concept branching from ${branch}`} onClick={() => setCreating(true)}>
        + Concept
      </button>
      {creating && (
        <div className="concept-form">
          <div className="concept-form-label">New concept on “{branch}”</div>
          <input
            ref={inputRef}
            value={name}
            placeholder="galley_two"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              } else if (e.key === "Enter") {
                const n = name.trim();
                if (!/^[a-z_][a-z0-9_]*$/.test(n)) {
                  setError("lowercase identifier, e.g. galley_two");
                  return;
                }
                if (project?.layers.has(n) === true) {
                  setError(`"${n}" already exists`);
                  return;
                }
                newConcept(n);
                setCreating(false);
                setName("");
              }
            }}
            onBlur={() => setCreating(false)}
          />
          {error !== null ? (
            <div className="field-error">{error}</div>
          ) : (
            <div className="concept-form-hint">Enter to create · Esc to cancel</div>
          )}
        </div>
      )}
    </div>
  );
}

function TopBar(): JSX.Element {
  const tool = useApp((s) => s.tool);
  const wallType = useApp((s) => s.wallType);
  const setWallType = useApp((s) => s.setWallType);
  const pipeline = useApp((s) => s.pipeline);
  const openFolder = useApp((s) => s.openFolder);
  const saveAll = useApp((s) => s.saveAll);
  const loadDemo = useApp((s) => s.loadDemo);
  const dirty = useApp((s) => s.dirty);
  const dirHandle = useApp((s) => s.dirHandle);
  const past = useApp((s) => s.past);
  const future = useApp((s) => s.future);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const branch = useApp((s) => s.branch);
  const level = useApp((s) => s.level);
  const viewMode = useApp((s) => s.viewMode);
  const titleRows = useTitleRows();

  const exportPng = (): void => {
    const svg = document.querySelector<SVGSVGElement>("svg.plan");
    if (svg === null) {
      useApp.getState().showToast("No 2D sheet to export", "error");
      return;
    }
    const name = `${branch}${level !== null ? `_${level}` : ""}_${today()}.png`;
    void exportPlanPng(svg, titleRows, name).catch((e) =>
      useApp.getState().showToast(`Export failed: ${(e as Error).message}`, "error"),
    );
  };

  const wallTypes = useMemo(() => {
    const out: string[] = [];
    if (pipeline !== null) {
      for (const [key, eff] of pipeline.resolved.effective) {
        if (eff.stmt.kind === "walltype") out.push(key);
      }
    }
    return out.sort();
  }, [pipeline]);

  const dirtyCount = Object.keys(dirty).length;

  return (
    <div className="topbar">
      <span className="wordmark">
        AS<em>BUILT</em>
      </span>
      <SheetPicker />
      {tool === "wall" && (
        <div className="bar-context">
          <label className="bar-label">drawing with</label>
          <select value={wallType} onChange={(e) => setWallType(e.target.value)}>
            {wallTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="spacer" />
      <ViewToggle />
      <div className="spacer" />
      <div className="bar-group">
        <button title="Undo (⌘Z)" disabled={past.length === 0} onClick={undo}>
          ↩
        </button>
        <button title="Redo (⇧⌘Z)" disabled={future.length === 0} onClick={redo}>
          ↪
        </button>
      </div>
      <div className="bar-group">
        {fsAccessSupported() && <button onClick={() => void openFolder()}>Open…</button>}
        <button onClick={() => void saveAll()} disabled={dirtyCount === 0 || dirHandle === null}>
          Save{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
        </button>
        <button onClick={exportPng} disabled={viewMode === "3d"} title="Export the 2D sheet as PNG">
          PNG
        </button>
        <button onClick={loadDemo}>Demo</button>
      </div>
    </div>
  );
}

/** Title-block rows, shared by the on-screen block and the PNG export. */
function useTitleRows(): TitleRow[] {
  const pipeline = useApp((s) => s.pipeline);
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const dirHandle = useApp((s) => s.dirHandle);
  const level = useApp((s) => s.level);
  if (pipeline === null || project === null) return [];
  const params = allParams(pipeline);
  const measured = params.filter((p) => p.prov === "measured").length;
  const toMeasure = params.filter((p) => p.prov === "approximated").length;
  const conflicts = pipeline.solution.contradictions.length;
  const parent = project.layers.get(branch)?.parsed.header.parent ?? null;
  const levels = levelViews(pipeline);
  const rows: TitleRow[] = [
    { label: "Project", value: dirHandle?.name ?? "demo (browser only)" },
    { label: "Sheet", value: parent !== null ? `${branch} ← ${parent}` : branch },
  ];
  if (levels.length > 1) {
    rows.push({ label: "Level", value: level ?? "ground" });
  }
  rows.push({ label: "Date", value: today() });
  rows.push({
    label: "Survey",
    value:
      `${measured} measured · ${toMeasure} to measure` +
      (conflicts > 0 ? ` · ${conflicts} conflict${conflicts > 1 ? "s" : ""}` : ""),
    conflict: conflicts > 0,
  });
  return rows;
}

/** Sheet tabs for multi-level models: pick which floor the 2D sheet shows. */
function LevelTabs(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const level = useApp((s) => s.level);
  const setLevel = useApp((s) => s.setLevel);
  const viewMode = useApp((s) => s.viewMode);
  if (pipeline === null || viewMode === "3d") return null;
  const levels = levelViews(pipeline);
  if (levels.length < 2) return null;
  return (
    <div className="level-tabs">
      {levels.map((l) => (
        <button
          key={l.ns ?? "(ground)"}
          className={level === l.ns ? "active" : ""}
          title={l.ns === null ? `Ground level (0")` : `${l.ns} at ${fmt16(l.elevInches)}`}
          onClick={() => setLevel(l.ns)}
        >
          {l.ns ?? "ground"}
        </button>
      ))}
    </div>
  );
}

/** The sheet's title block: live project/sheet/survey state, drafting-style. */
function TitleBlock(): JSX.Element | null {
  const viewMode = useApp((s) => s.viewMode);
  const rows = useTitleRows();
  if (rows.length === 0 || viewMode === "3d") return null;

  return (
    <div className={`titleblock ${viewMode === "split" ? "titleblock-split" : ""}`}>
      {rows.map((r) => (
        <div className="tb-row" key={r.label}>
          <span className="tb-label">{r.label}</span>
          <span className="tb-value">
            {r.conflict === true ? <span className="tb-conflict">{r.value}</span> : r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- inspector */

const GRADE_SHORT: Record<Grade, string> = {
  measured: "meas",
  designed: "design",
  approximated: "approx",
  drawn: "drawn",
};

function GradeChip({ grade }: { grade: Grade }): JSX.Element {
  return (
    <span
      className="chip"
      title={grade}
      style={{ color: GRADE_DARK[grade], borderColor: GRADE_DARK[grade] }}
    >
      {GRADE_SHORT[grade]}
    </span>
  );
}

function Prop({
  label,
  children,
  refs,
}: {
  label: string;
  children: ReactNode;
  /** Canvas keys this row refers to: hovering the row lights them up. */
  refs?: string[];
}): JSX.Element {
  const hover =
    refs === undefined || refs.length === 0
      ? {}
      : {
          onMouseEnter: () => useApp.getState().setHighlight(refs),
          onMouseLeave: () => useApp.getState().setHighlight([]),
        };
  return (
    <div className="prop" {...hover}>
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

function WallPanel({ selection }: { selection: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline)!;
  const project = useApp((s) => s.project)!;
  const branch = useApp((s) => s.branch);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const openEditor = useApp((s) => s.openEditor);
  const grades = useMemo(() => allWallGrades(pipeline), [pipeline]);

  const eff = pipeline.resolved.effective.get(selection);
  if (eff?.stmt.kind !== "wall") return null;
  const w = wallView(pipeline, selection);
  if (w === null) return null;
  const g = grades.get(selection);

  // A wall length is directly editable when it's bound to a single param.
  const binding = pipeline.resolved.effective.get(`${selection}.length`);
  let boundParam: string | null = null;
  if (binding?.stmt.kind === "length") {
    const terms = binding.stmt.expr.terms;
    const first = terms[0];
    if (terms.length === 1 && first !== undefined && first.kind === "ref" && first.sign === 1) {
      boundParam = first.name;
    }
  }
  const paramEff = boundParam !== null ? pipeline.resolved.effective.get(boundParam) : undefined;
  const paramProv: Provenance =
    paramEff?.stmt.kind === "param" || paramEff?.stmt.kind === "set"
      ? paramEff.stmt.prov
      : "approximated";

  const wallTypes: string[] = [];
  for (const [key, e] of pipeline.resolved.effective) {
    if (e.stmt.kind === "walltype") wallTypes.push(key);
  }

  return (
    <div className="panel">
      <h3>Wall {selection}</h3>
      <Prop label="Length" refs={[selection]}>
        {boundParam !== null ? (
          <LengthField
            inches={w.lengthInches}
            title={`Edits ${boundParam} (${paramProv})`}
            preview={(v) =>
              proposeSetParam(
                project,
                branch,
                boundParam!,
                v,
                paramProv,
                paramProv === "measured" ? today() : undefined,
              )
            }
            apply={(v) =>
              commitEdits(() =>
                proposeSetParam(
                  project,
                  branch,
                  boundParam!,
                  v,
                  paramProv,
                  paramProv === "measured" ? today() : undefined,
                ),
              )
            }
          />
        ) : (
          <span className="ro">{fmt16(w.lengthInches)}</span>
        )}
        {g !== undefined && <GradeChip grade={g.grade} />}
      </Prop>
      <Prop label="Type">
        <select
          value={w.wallType}
          onChange={(e) => {
            const err = commitEdits(() =>
              proposeSetWallType(project, branch, selection, e.target.value),
            );
            if (err !== null) useApp.getState().showToast(err, "error");
          }}
        >
          {wallTypes.sort().map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Prop>
      <Prop label="Runs" refs={[w.from, w.to]}>
        <span className="ro mono">
          {w.from} → {w.to}
        </span>
      </Prop>
      {g !== undefined && g.support.length > 0 && (
        <Prop label="Driven by" refs={g.support.flatMap((k) => canvasKeysFor(pipeline, k))}>
          <span className="ro mono">{g.support.join(", ")}</span>
        </Prop>
      )}
      <Prop label="Layer">
        <span className="ro mono">
          {eff.expandedFrom !== undefined ? `${eff.layer} (from ${eff.expandedFrom})` : eff.layer}
        </span>
      </Prop>
      <div className="panel-actions">
        <button
          onClick={(e) =>
            openEditor({
              target: { kind: "measure-wall", wall: selection },
              anchor: { x: e.clientX, y: e.clientY },
              initial: "",
              label: `Measured ${selection}`,
            })
          }
        >
          Record measurement
        </button>
        <button
          className="danger"
          onClick={deleteSelection}
          {...hoverPreview(() => proposeDelete(project, branch, selection))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function JunctionPanel({ selection }: { selection: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline)!;
  const project = useApp((s) => s.project)!;
  const branch = useApp((s) => s.branch);
  const eff = pipeline.resolved.effective.get(selection);
  if (eff?.stmt.kind !== "junction") return null;
  const pos = junctionPos(pipeline.solution, selection);
  if (pos === null) return null;

  const move = (x: number, y: number): string | null => {
    try {
      const proposal = proposeMove(project, branch, selection, {
        x: Math.round(x * 64),
        y: Math.round(y * 64),
      });
      if (proposal.kind === "refusal") return proposal.message;
      if (!proposal.verified) return "no clean edit reaches that position";
      useApp.getState().runEdits(proposal.edits);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const movePreview = (x: number, y: number): TextEdit[] => {
    const proposal = proposeMove(project, branch, selection, {
      x: Math.round(x * 64),
      y: Math.round(y * 64),
    });
    return proposal.kind === "refusal" || !proposal.verified ? [] : proposal.edits;
  };

  return (
    <div className="panel">
      <h3>Junction {selection}</h3>
      <Prop label="X (east)" refs={[selection]}>
        <LengthField
          inches={pos.x}
          preview={(v) => movePreview(v / 64, pos.y)}
          apply={(v) => move(v / 64, pos.y)}
        />
      </Prop>
      <Prop label="Y (north)" refs={[selection]}>
        <LengthField
          inches={pos.y}
          preview={(v) => movePreview(pos.x, v / 64)}
          apply={(v) => move(pos.x, v / 64)}
        />
      </Prop>
      <Prop label="Layer">
        <span className="ro mono">{eff.layer}</span>
      </Prop>
      <p className="hint">
        Edits move through the solver: bound dimensions update; measured ones refuse.
      </p>
    </div>
  );
}

function OpeningPanel({ selection }: { selection: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline)!;
  const project = useApp((s) => s.project)!;
  const branch = useApp((s) => s.branch);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const eff = pipeline.resolved.effective.get(selection);
  if (eff?.stmt.kind !== "opening") return null;
  const s = eff.stmt;
  const view = openingViews(pipeline).find((o) => o.key === selection);

  return (
    <div className="panel">
      <h3>
        {s.opKind === "door" ? "Door" : "Window"} {selection}
        {view?.overflow === true && <span className="overflow-badge">doesn't fit</span>}
      </h3>
      <Prop label="In wall" refs={[s.wall]}>
        <span className="ro mono">{s.wall}</span>
      </Prop>
      <Prop label="Width" refs={[selection]}>
        <LengthField
          inches={s.width / 64}
          preview={(v) => proposeSetOpening(project, branch, selection, { width: v })}
          apply={(v) => commitEdits(() => proposeSetOpening(project, branch, selection, { width: v }))}
        />
      </Prop>
      <Prop label="Height" refs={[selection]}>
        <LengthField
          inches={s.height / 64}
          apply={(v) => commitEdits(() => proposeSetOpening(project, branch, selection, { height: v }))}
        />
      </Prop>
      {s.opKind === "window" && (
        <Prop label="Sill" refs={[selection]}>
          <LengthField
            inches={(s.sill ?? 0) / 64}
            apply={(v) => commitEdits(() => proposeSetOpening(project, branch, selection, { sill: v }))}
          />
        </Prop>
      )}
      <Prop label={`From ${s.anchor}`} refs={[s.anchor, selection]}>
        <LengthField
          inches={view?.offsetInches ?? 0}
          title="Offset along the wall to the near jamb"
          preview={(v) => proposeSetOpeningOffset(project, branch, selection, v)}
          apply={(v) => commitEdits(() => proposeSetOpeningOffset(project, branch, selection, v))}
        />
      </Prop>
      <Prop label="Layer">
        <span className="ro mono">{eff.layer}</span>
      </Prop>
      <div className="panel-actions">
        <button
          className="danger"
          onClick={deleteSelection}
          {...hoverPreview(() => proposeDelete(project, branch, selection))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function FixturePanel({ selection }: { selection: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline)!;
  const project = useApp((s) => s.project)!;
  const branch = useApp((s) => s.branch);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const rotateFixture = useApp((s) => s.rotateFixture);
  const eff = pipeline.resolved.effective.get(selection);
  if (eff?.stmt.kind !== "fixture") return null;
  const s = eff.stmt;

  return (
    <div className="panel">
      <h3>Fixture {selection}</h3>
      <Prop label="Kind">
        <Field
          value={s.fixKind}
          placeholder="fridge"
          onCommit={(raw) => {
            const n = raw.trim();
            if (!/^[a-z_][a-z0-9_]*$/.test(n)) return "lowercase identifier, e.g. fridge";
            return commitEdits(() => proposeSetFixture(project, branch, selection, { fixKind: n }));
          }}
        />
      </Prop>
      <Prop label="Width" refs={[selection]}>
        <LengthField
          inches={s.w / 64}
          preview={(v) => proposeSetFixture(project, branch, selection, { w: v })}
          apply={(v) => commitEdits(() => proposeSetFixture(project, branch, selection, { w: v }))}
        />
      </Prop>
      <Prop label="Depth" refs={[selection]}>
        <LengthField
          inches={s.d / 64}
          preview={(v) => proposeSetFixture(project, branch, selection, { d: v })}
          apply={(v) => commitEdits(() => proposeSetFixture(project, branch, selection, { d: v }))}
        />
      </Prop>
      <Prop label="Center X" refs={[selection]}>
        <LengthField
          inches={s.at.x / 64}
          preview={(v) => proposeSetFixture(project, branch, selection, { at: { x: v, y: s.at.y } })}
          apply={(v) =>
            commitEdits(() =>
              proposeSetFixture(project, branch, selection, { at: { x: v, y: s.at.y } }),
            )
          }
        />
      </Prop>
      <Prop label="Center Y" refs={[selection]}>
        <LengthField
          inches={s.at.y / 64}
          preview={(v) => proposeSetFixture(project, branch, selection, { at: { x: s.at.x, y: v } })}
          apply={(v) =>
            commitEdits(() =>
              proposeSetFixture(project, branch, selection, { at: { x: s.at.x, y: v } }),
            )
          }
        />
      </Prop>
      <Prop label="Rotation" refs={[selection]}>
        <span className="ro mono">{s.rot}°</span>
        <button
          onClick={() => rotateFixture(selection)}
          {...hoverPreview(() =>
            proposeSetFixture(project, branch, selection, {
              rot: (((s.rot + 90) % 360) as 0 | 90 | 180 | 270),
            }),
          )}
        >
          Rotate 90°
        </button>
      </Prop>
      <div className="panel-actions">
        <button
          className="danger"
          onClick={deleteSelection}
          {...hoverPreview(() => proposeDelete(project, branch, selection))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function MeasPanel({ selection }: { selection: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline)!;
  const project = useApp((s) => s.project)!;
  const branch = useApp((s) => s.branch);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const eff = pipeline.resolved.effective.get(selection);
  if (eff?.stmt.kind !== "meas") return null;
  const s = eff.stmt;

  return (
    <div className="panel">
      <h3>Measurement {selection}</h3>
      <Prop label="Span" refs={[selection, s.a, s.b]}>
        <span className="ro mono">
          {s.a} → {s.b}
        </span>
      </Prop>
      <Prop label="Tape read" refs={[selection]}>
        <LengthField
          inches={s.value / 64}
          title="Correcting a reading re-dates it to today"
          preview={(v) => proposeEditMeas(project, branch, selection, v, today())}
          apply={(v) => commitEdits(() => proposeEditMeas(project, branch, selection, v, today()))}
        />
      </Prop>
      {s.date !== undefined && (
        <Prop label="Taped">
          <span className="ro mono">{s.date}</span>
        </Prop>
      )}
      <div className="panel-actions">
        <button
          className="danger"
          onClick={deleteSelection}
          {...hoverPreview(() => proposeDelete(project, branch, selection))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function SelectionPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const selection = useApp((s) => s.selection);
  if (pipeline === null || selection === null) return null;
  const eff = pipeline.resolved.effective.get(selection);
  if (eff === undefined) return null;
  switch (eff.stmt.kind) {
    case "wall":
      return <WallPanel selection={selection} />;
    case "junction":
      return <JunctionPanel selection={selection} />;
    case "opening":
      return <OpeningPanel selection={selection} />;
    case "fixture":
      return <FixturePanel selection={selection} />;
    case "meas":
      return <MeasPanel selection={selection} />;
    default:
      return null;
  }
}

/** The current sheet itself: parentage (re-parent = rebase) + ghost toggle. */
function SheetPanel(): JSX.Element | null {
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const selection = useApp((s) => s.selection);
  const reparent = useApp((s) => s.reparent);
  const ghost = useApp((s) => s.ghost);
  const toggleGhost = useApp((s) => s.toggleGhost);
  const ghostPipeline = useApp((s) => s.ghostPipeline);
  const [picking, setPicking] = useState(false);

  const layer = project?.layers.get(branch);
  const parents = useMemo(() => {
    if (project === undefined || project === null || layer === undefined) return [];
    // A sheet may hang off anything that doesn't descend from it.
    const children = new Map<string, string[]>();
    for (const [name, l] of project.layers) {
      const p = l.parsed.header.parent;
      if (p !== null) children.set(p, [...(children.get(p) ?? []), name]);
    }
    const below = new Set<string>([branch]);
    const stack = [branch];
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      for (const c of children.get(cur) ?? []) {
        if (!below.has(c)) {
          below.add(c);
          stack.push(c);
        }
      }
    }
    return [...project.layers.keys()].filter((n) => !below.has(n)).sort();
  }, [project, layer, branch]);

  if (project === null || layer === undefined || selection !== null) return null;
  const parent = layer.parsed.header.parent;

  return (
    <div className="panel">
      <h3>Sheet</h3>
      <Prop label="Sheet">
        <span className="mono">{branch}</span>
      </Prop>
      <Prop label="Parent">
        {parent === null ? (
          <span className="prop-muted">— as-built root</span>
        ) : (
          <span className="parent-picker">
            <button
              className="field mono"
              title="Re-parent this sheet (rebases it onto the new parent)"
              onClick={() => setPicking(!picking)}
            >
              {parent} ▾
            </button>
            {picking && (
              <span className="parent-options">
                {parents.map((p) => (
                  <button
                    key={p}
                    className={p === parent ? "active" : ""}
                    {...hoverPreview(() => proposeReparent(project, branch, p))}
                    onClick={() => {
                      setPicking(false);
                      useApp.getState().clearPreview();
                      if (p !== parent) reparent(p);
                    }}
                  >
                    {p}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </Prop>
      {parent !== null && ghostPipeline !== null && (
        <Prop label="Ghost">
          <label className="ghost-toggle" title={`Show “${parent}” dashed under this sheet`}>
            <input type="checkbox" checked={ghost} onChange={toggleGhost} /> show {parent}{" "}
            underneath
          </label>
        </Prop>
      )}
      <Prop label="File">
        <span className="mono prop-muted">{layer.file}</span>
      </Prop>
    </div>
  );
}

/* -------------------------------------------------- dimensions & problems */

function ParamsPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const openEditor = useApp((s) => s.openEditor);
  if (pipeline === null || project === null) return null;
  const params = allParams(pipeline);
  const audit = params.filter((p) => p.prov === "approximated");

  return (
    <div className="panel">
      <h3>
        Dimensions{" "}
        {audit.length > 0 && <span className="audit-badge">{audit.length} to measure</span>}
      </h3>
      <table className="params">
        <tbody>
          {params.map((p) => (
            <tr
              key={p.name}
              className={p.prov === "approximated" ? "row-audit" : ""}
              onMouseEnter={() => useApp.getState().setHighlight(keysForParam(pipeline, p.name))}
              onMouseLeave={() => useApp.getState().setHighlight([])}
            >
              <td className="param-name">{p.name}</td>
              <td className="param-value">
                <LengthField
                  inches={p.solvedInches}
                  title={`Edit ${p.name} (stays ${p.prov})`}
                  preview={(v) =>
                    proposeSetParam(
                      project,
                      branch,
                      p.name,
                      v,
                      p.prov,
                      p.prov === "measured" ? today() : undefined,
                    )
                  }
                  apply={(v) =>
                    commitEdits(() =>
                      proposeSetParam(
                        project,
                        branch,
                        p.name,
                        v,
                        p.prov,
                        p.prov === "measured" ? today() : undefined,
                      ),
                    )
                  }
                />
                {Math.abs(p.solvedInches - p.authoredInches) > 1 / 32 && (
                  <span
                    className="drift"
                    title={`authored ${formatLength(Math.round(p.authoredInches * 64))}`}
                  >
                    *
                  </span>
                )}
              </td>
              <td>
                <GradeChip grade={p.prov} />
              </td>
              <td className="param-actions">
                {p.prov !== "measured" && (
                  <button
                    title="Record a tape measurement"
                    onClick={(e) =>
                      openEditor({
                        target: { kind: "param-measure", name: p.name },
                        anchor: { x: e.clientX, y: e.clientY },
                        initial: "",
                        label: `Measured ${p.name}`,
                      })
                    }
                  >
                    📏
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One suspect row inside a contradiction card, with its resolution actions. */
function SuspectRow({ suspect }: { suspect: string }): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const project = useApp((s) => s.project);
  const runEdits = useApp((s) => s.runEdits);
  const setParam = useApp((s) => s.setParam);
  const openEditor = useApp((s) => s.openEditor);
  const branch = useApp((s) => s.branch);
  if (pipeline === null || project === null) return null;
  const eff = pipeline.resolved.effective.get(suspect);
  if (eff === undefined) return null;
  const s = eff.stmt;

  const doDelete = (): void => {
    runEdits(proposeDelete(project, branch, suspect));
  };
  const rowHover = {
    onMouseEnter: () => useApp.getState().setHighlight(canvasKeysFor(pipeline, suspect)),
    onMouseLeave: () => useApp.getState().setHighlight([]),
  };

  if (s.kind === "meas") {
    return (
      <div className="suspect-row" {...rowHover}>
        <span className="suspect-name">
          {suspect} = {formatLength(s.value)}{" "}
          <em>(measured{s.date !== undefined ? ` ${s.date}` : ""})</em>
        </span>
        <span className="suspect-actions">
          <button
            onClick={(e) =>
              openEditor({
                target: { kind: "meas-edit", name: suspect },
                anchor: { x: e.clientX, y: e.clientY },
                initial: formatLength(s.value),
                label: `Correct ${suspect}`,
              })
            }
          >
            Correct
          </button>
          <button onClick={doDelete} {...hoverPreview(() => proposeDelete(project, branch, suspect))}>
            Remove
          </button>
        </span>
      </div>
    );
  }

  if ((s.kind === "param" || s.kind === "set") && s.prov === "measured") {
    return (
      <div className="suspect-row" {...rowHover}>
        <span className="suspect-name">
          {suspect} = {formatLength(s.value)} <em>(measured)</em>
        </span>
        <span className="suspect-actions">
          <button
            onClick={(e) =>
              openEditor({
                target: { kind: "param", name: suspect, prov: "measured" },
                anchor: { x: e.clientX, y: e.clientY },
                initial: formatLength(s.value),
                label: `Correct ${suspect}`,
              })
            }
          >
            Correct
          </button>
          <button
            title="Keep the value but stop treating it as gospel"
            onClick={() => setParam(suspect, s.value, "approximated")}
            {...hoverPreview(() => proposeSetParam(project, branch, suspect, s.value, "approximated"))}
          >
            → approx
          </button>
        </span>
      </div>
    );
  }

  if (s.kind === "length" || s.kind === "axis") {
    const what = s.kind === "length" ? "equal-walls default" : "square-corner default";
    return (
      <div className="suspect-row" {...rowHover}>
        <span className="suspect-name">
          {suspect} <em>({what})</em>
        </span>
        <span className="suspect-actions">
          <button
            title="Remove this default so the geometry can go out of square"
            onClick={doDelete}
            {...hoverPreview(() => proposeDelete(project, branch, suspect))}
          >
            Relax
          </button>
        </span>
      </div>
    );
  }

  return null;
}

/** A masked correction card: the base changed a value this sheet overrides. */
function MaskedCard({ diag }: { diag: Diagnostic }): JSX.Element {
  const pipeline = useApp((s) => s.pipeline);
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const resolveMasked = useApp((s) => s.resolveMasked);
  const name = diag.key!;
  const { base, override } = diag.data as { base: S64; was: S64; override: S64 };
  const owner = pipeline?.resolved.effective.get(name)?.layer;
  return (
    <div className="diag diag-warning">
      <strong>Base corrected under your override</strong> — {name} measures{" "}
      {formatLength(base)} now; this sheet holds {formatLength(override)}.
      {owner === branch ? (
        <div className="review-actions">
          <button
            title={`Keep ${formatLength(override)} and acknowledge the new base`}
            onClick={() => resolveMasked(name, "keep")}
            {...hoverPreview(() => proposeResolveMasked(project!, branch, name, "keep"))}
          >
            Keep {formatLength(override)}
          </button>
          <button
            title="Drop the override; the corrected base shows through"
            onClick={() => resolveMasked(name, "adopt")}
            {...hoverPreview(() => proposeResolveMasked(project!, branch, name, "adopt"))}
          >
            Adopt {formatLength(base)}
          </button>
        </div>
      ) : (
        <div className="diag-note">Override lives on “{owner}” — resolve it there.</div>
      )}
    </div>
  );
}

/** An orphan card: a statement pointing at something that no longer exists. */
function OrphanCard({ diag }: { diag: Diagnostic }): JSX.Element {
  const dropOrphan = useApp((s) => s.dropOrphan);
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  return (
    <div className="diag diag-error">
      {diag.message}
      {diag.key !== undefined && (
        <div className="suspect-row">
          <span className="suspect-name">{diag.key}</span>
          <span className="suspect-actions">
            <button
              title="Drop this statement from the sheet"
              onClick={() => dropOrphan(diag.key!)}
              {...hoverPreview(() => proposeDropOrphan(project!, branch, diag.key!))}
            >
              Remove
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function DiagnosticsPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const pipelineError = useApp((s) => s.pipelineError);
  if (pipelineError !== null) {
    return (
      <div className="panel">
        <h3>Review</h3>
        <div className="diag diag-error">{pipelineError}</div>
      </div>
    );
  }
  if (pipeline === null) return null;
  const diags = pipeline.diagnostics.filter((d) => d.severity !== "info");
  const contradictions = pipeline.solution.contradictions;
  if (diags.length === 0 && contradictions.length === 0) return null;
  return (
    <div className="panel">
      <h3>Review</h3>
      {contradictions.map((c, i) => (
        <div key={`c${i}`} className="diag diag-error">
          <strong>Measurements disagree</strong> — off by{" "}
          {formatLength(Math.round(Math.max(...c.violated.map((v) => v.residualInches)) * 64))}.
          Pick what gives:
          {c.suspects.map((s) => (
            <SuspectRow key={s} suspect={s} />
          ))}
        </div>
      ))}
      {diags.map((d, i) => {
        if (d.code === "masked-correction" && d.key !== undefined) {
          return <MaskedCard key={`${d.code}:${d.key}`} diag={d} />;
        }
        if (d.code === "unknown-ref" || d.code === "set-missing-base") {
          return <OrphanCard key={`${d.code}:${d.key ?? i}`} diag={d} />;
        }
        return (
          <div key={i} className={`diag diag-${d.severity}`}>
            {d.message}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ value editor */

function ValueEditor(): JSX.Element | null {
  const editor = useApp((s) => s.editor);
  const commitEditor = useApp((s) => s.commitEditor);
  const closeEditor = useApp((s) => s.closeEditor);
  const previewEditorValue = useApp((s) => s.previewEditorValue);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editor !== null) {
      setText(editor.initial);
      setError(null);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editor]);

  if (editor === null) return null;
  const left = Math.min(editor.anchor.x, window.innerWidth - 240);
  const top = Math.min(editor.anchor.y + 8, window.innerHeight - 90);

  return (
    <div className="value-editor" style={{ left, top }}>
      <div className="value-editor-label">{editor.label}</div>
      <input
        ref={inputRef}
        value={text}
        placeholder={`e.g. 11'-8 1/2"`}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          previewEditorValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const err = commitEditor(text);
            if (err !== null) setError(err);
          } else if (e.key === "Escape") {
            closeEditor();
          }
          e.stopPropagation();
        }}
      />
      {error !== null && <div className="value-editor-error">{error}</div>}
      <div className="value-editor-hint">Enter to apply · Esc to cancel</div>
    </div>
  );
}

/* ------------------------------------------------------------------- app */

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  w: "wall",
  m: "measure",
  d: "door",
  n: "window",
  f: "fixture",
};

export default function App(): JSX.Element {
  const boot = useApp((s) => s.boot);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool !== undefined) useApp.getState().setTool(tool);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const viewMode = useApp((s) => s.viewMode);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <ToolRail />
        <div className="canvas">
          {viewMode !== "3d" && <Plan2D />}
          {viewMode !== "2d" && <View3D />}
          <LevelTabs />
          <TitleBlock />
        </div>
        <div className="sidebar">
          <SelectionPanel />
          <SheetPanel />
          <DiagnosticsPanel />
          <ParamsPanel />
          <div className="panel hint-panel">
            <p className="hint">
              Click a value to edit it. <b>Measure</b>: click a wall, or two junctions for a
              diagonal, then type the tape reading. Scroll pans, pinch/⌘-scroll zooms — in 2D
              and 3D. ⌫ deletes, ⌘Z undoes.
            </p>
          </div>
        </div>
      </div>
      <ValueEditor />
      <Toast />
    </div>
  );
}
