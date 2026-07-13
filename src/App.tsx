import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  allParams,
  formatLength,
  proposeDelete,
  wallView,
  allWallGrades,
  type Grade,
} from "./core";
import { fsAccessSupported } from "./persist";
import { useApp } from "./state/store";
import { GRADE_COLORS, Plan2D } from "./ui2d/Plan2D";
import { View3D } from "./ui3d/View3D";

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

function Toolbar(): JSX.Element {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const wallType = useApp((s) => s.wallType);
  const setWallType = useApp((s) => s.setWallType);
  const pipeline = useApp((s) => s.pipeline);
  const openFolder = useApp((s) => s.openFolder);
  const saveAll = useApp((s) => s.saveAll);
  const loadDemo = useApp((s) => s.loadDemo);
  const dirty = useApp((s) => s.dirty);
  const dirHandle = useApp((s) => s.dirHandle);

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
    <div className="toolbar">
      <span className="logo">AsBuilt</span>
      <div className="tool-group">
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
          Select
        </button>
        <button className={tool === "wall" ? "active" : ""} onClick={() => setTool("wall")}>
          Wall
        </button>
        <button
          className={tool === "measure" ? "active" : ""}
          onClick={() => setTool("measure")}
          title="Record a tape measurement: click a wall, or two junctions (diagonals welcome)"
        >
          Measure
        </button>
        <button className={tool === "door" ? "active" : ""} onClick={() => setTool("door")}>
          Door
        </button>
        <button className={tool === "window" ? "active" : ""} onClick={() => setTool("window")}>
          Window
        </button>
        <button className={tool === "fixture" ? "active" : ""} onClick={() => setTool("fixture")}>
          Fixture
        </button>
        <select value={wallType} onChange={(e) => setWallType(e.target.value)}>
          {wallTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="spacer" />
      <ViewToggle />
      <div className="spacer" />
      <BranchPicker />
      <div className="spacer" />
      <div className="tool-group">
        {fsAccessSupported() && <button onClick={() => void openFolder()}>Open…</button>}
        <button onClick={() => void saveAll()} disabled={dirtyCount === 0 || dirHandle === null}>
          Save{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
        </button>
        <button onClick={loadDemo}>Demo</button>
      </div>
    </div>
  );
}

function ViewToggle(): JSX.Element {
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  return (
    <div className="tool-group">
      <button className={viewMode === "2d" ? "active" : ""} onClick={() => setViewMode("2d")}>
        2D
      </button>
      <button className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>
        3D
      </button>
      <button
        className={viewMode === "split" ? "active" : ""}
        onClick={() => setViewMode("split")}
      >
        Split
      </button>
    </div>
  );
}

function BranchPicker(): JSX.Element {
  const project = useApp((s) => s.project);
  const branch = useApp((s) => s.branch);
  const setBranch = useApp((s) => s.setBranch);
  const newConcept = useApp((s) => s.newConcept);

  const branches = useMemo(() => {
    if (project === null) return [];
    return [...project.layers.entries()].map(([name, l]) => ({
      name,
      parent: l.parsed.header.parent,
    }));
  }, [project]);

  return (
    <div className="tool-group">
      <label className="branch-label">Branch</label>
      <select value={branch} onChange={(e) => setBranch(e.target.value)}>
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
            {b.parent !== null ? ` (← ${b.parent})` : ""}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          const name = window.prompt("New concept name (branches from current):");
          if (name !== null && name.trim() !== "") newConcept(name.trim());
        }}
      >
        + Concept
      </button>
    </div>
  );
}

function GradeChip({ grade }: { grade: Grade }): JSX.Element {
  return (
    <span className="chip" style={{ color: GRADE_COLORS[grade], borderColor: GRADE_COLORS[grade] }}>
      {grade}
    </span>
  );
}

function ParamsPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const openEditor = useApp((s) => s.openEditor);
  if (pipeline === null) return null;
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
            <tr key={p.name} className={p.prov === "approximated" ? "row-audit" : ""}>
              <td className="param-name">{p.name}</td>
              <td className="param-value">
                {formatLength(Math.round(p.solvedInches * 64))}
                {Math.abs(p.solvedInches - p.authoredInches) > 1 / 32 && (
                  <span className="drift" title={`authored ${formatLength(Math.round(p.authoredInches * 64))}`}>
                    *
                  </span>
                )}
              </td>
              <td>
                <GradeChip grade={p.prov} />
              </td>
              <td className="param-actions">
                <button
                  title="Edit value"
                  onClick={(e) =>
                    openEditor({
                      target: { kind: "param", name: p.name, prov: p.prov },
                      anchor: { x: e.clientX, y: e.clientY },
                      initial: formatLength(Math.round(p.authoredInches * 64)),
                      label: `${p.name} (${p.prov})`,
                    })
                  }
                >
                  ✎
                </button>
                {p.prov !== "measured" && (
                  <button
                    title="Record a measurement"
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

function ValueEditor(): JSX.Element | null {
  const editor = useApp((s) => s.editor);
  const commitEditor = useApp((s) => s.commitEditor);
  const closeEditor = useApp((s) => s.closeEditor);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editor !== null) {
      setText(editor.initial);
      setError(null);
      // focus after mount
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

  if (s.kind === "meas") {
    return (
      <div className="suspect-row">
        <span className="suspect-name">
          {suspect} = {formatLength(s.value)} <em>(measured{s.date !== undefined ? ` ${s.date}` : ""})</em>
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
            ✎
          </button>
          <button onClick={doDelete}>Remove</button>
        </span>
      </div>
    );
  }

  if ((s.kind === "param" || s.kind === "set") && s.prov === "measured") {
    return (
      <div className="suspect-row">
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
            ✎
          </button>
          <button
            title="Keep the value but stop treating it as gospel"
            onClick={() => setParam(suspect, s.value, "approximated")}
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
      <div className="suspect-row">
        <span className="suspect-name">
          {suspect} <em>({what})</em>
        </span>
        <span className="suspect-actions">
          <button
            title="Remove this default so the geometry can go out of square"
            onClick={doDelete}
          >
            Relax
          </button>
        </span>
      </div>
    );
  }

  return null;
}

function DiagnosticsPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const pipelineError = useApp((s) => s.pipelineError);
  if (pipelineError !== null) {
    return (
      <div className="panel">
        <h3>Problems</h3>
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
      <h3>Problems</h3>
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
      {diags.map((d, i) => (
        <div key={i} className={`diag diag-${d.severity}`}>
          {d.message}
        </div>
      ))}
    </div>
  );
}

function SelectionPanel(): JSX.Element | null {
  const pipeline = useApp((s) => s.pipeline);
  const selection = useApp((s) => s.selection);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const grades = useMemo(
    () => (pipeline === null ? null : allWallGrades(pipeline)),
    [pipeline],
  );
  if (pipeline === null || selection === null) return null;
  const eff = pipeline.resolved.effective.get(selection);
  if (eff === undefined) return null;

  if (eff.stmt.kind === "wall") {
    const w = wallView(pipeline, selection);
    const g = grades?.get(selection);
    if (w === null) return null;
    return (
      <div className="panel">
        <h3>Wall {selection}</h3>
        <dl>
          <dt>Length</dt>
          <dd>
            {formatLength(Math.round(w.lengthInches * 16) * 4)}{" "}
            {g !== undefined && <GradeChip grade={g.grade} />}
          </dd>
          <dt>Type</dt>
          <dd>{w.wallType}</dd>
          <dt>Runs</dt>
          <dd>
            {w.from} → {w.to}
          </dd>
          {g !== undefined && g.support.length > 0 && (
            <>
              <dt>Driven by</dt>
              <dd>{g.support.join(", ")}</dd>
            </>
          )}
          <dt>Layer</dt>
          <dd>{eff.expandedFrom !== undefined ? `${eff.layer} (from ${eff.expandedFrom})` : eff.layer}</dd>
        </dl>
        <button className="danger" onClick={deleteSelection}>
          Delete wall
        </button>
      </div>
    );
  }

  if (eff.stmt.kind === "junction") {
    return (
      <div className="panel">
        <h3>Junction {selection}</h3>
        <dl>
          <dt>Layer</dt>
          <dd>{eff.layer}</dd>
        </dl>
        <p className="hint">Drag to move. Moves become dimension edits when geometry is bound.</p>
      </div>
    );
  }

  if (eff.stmt.kind === "opening") {
    const s = eff.stmt;
    return (
      <div className="panel">
        <h3>
          {s.opKind === "door" ? "Door" : "Window"} {selection}
        </h3>
        <dl>
          <dt>In</dt>
          <dd>{s.wall}</dd>
          <dt>Size</dt>
          <dd>
            {formatLength(s.width)} × {formatLength(s.height)}
          </dd>
          {s.opKind === "window" && s.sill !== undefined && (
            <>
              <dt>Sill</dt>
              <dd>{formatLength(s.sill)}</dd>
            </>
          )}
          <dt>Anchored</dt>
          <dd>from {s.anchor}</dd>
          <dt>Layer</dt>
          <dd>{eff.layer}</dd>
        </dl>
        <p className="hint">Drag it along its wall to move.</p>
        <button className="danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    );
  }

  if (eff.stmt.kind === "fixture") {
    const s = eff.stmt;
    return (
      <div className="panel">
        <h3>Fixture {selection}</h3>
        <dl>
          <dt>Kind</dt>
          <dd>{s.fixKind}</dd>
          <dt>Size</dt>
          <dd>
            {formatLength(s.w)} × {formatLength(s.d)}
          </dd>
          <dt>Rotation</dt>
          <dd>{s.rot}°</dd>
        </dl>
        <div className="tool-group" style={{ marginBottom: 8 }}>
          <button onClick={() => useApp.getState().rotateFixture(selection)}>Rotate 90°</button>
        </div>
        <button className="danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    );
  }

  if (eff.stmt.kind === "meas") {
    const s = eff.stmt;
    return (
      <div className="panel">
        <h3>Measurement {selection}</h3>
        <dl>
          <dt>Span</dt>
          <dd>
            {s.a} → {s.b}
          </dd>
          <dt>Value</dt>
          <dd>{formatLength(s.value)}</dd>
          {s.date !== undefined && (
            <>
              <dt>Taped</dt>
              <dd>{s.date}</dd>
            </>
          )}
        </dl>
        <button className="danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    );
  }

  return null;
}

export default function App(): JSX.Element {
  const boot = useApp((s) => s.boot);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const viewMode = useApp((s) => s.viewMode);
  const sceneEpoch = useApp((s) => s.sceneEpoch);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        {viewMode !== "3d" && <Plan2D key={sceneEpoch} />}
        {viewMode !== "2d" && <View3D key={sceneEpoch} />}
        <div className="sidebar">
          <SelectionPanel />
          <DiagnosticsPanel />
          <ParamsPanel />
          <div className="panel hint-panel">
            <p className="hint">
              <b>Select</b>: click/drag, ⌫ deletes, ⌘Z undoes. <b>Wall</b>: click to chain, Esc
              ends. <b>Measure</b>: click a wall, or two junctions for a diagonal, then type the
              tape reading. Scroll pans, pinch/⌘-scroll zooms.
            </p>
          </div>
        </div>
      </div>
      <ValueEditor />
      <Toast />
    </div>
  );
}
