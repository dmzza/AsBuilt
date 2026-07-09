import { useEffect, useMemo, useState, type JSX } from "react";
import {
  allParams,
  formatLength,
  parseLength,
  wallView,
  allWallGrades,
  type Grade,
} from "./core";
import { fsAccessSupported } from "./persist";
import { useApp } from "./state/store";
import { GRADE_COLORS, Plan2D } from "./ui2d/Plan2D";

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
        <select value={wallType} onChange={(e) => setWallType(e.target.value)}>
          {wallTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="spacer" />
      <BranchPicker />
      <div className="spacer" />
      <div className="tool-group">
        {fsAccessSupported() && <button onClick={() => void openFolder()}>Open Folder…</button>}
        <button onClick={() => void saveAll()} disabled={dirtyCount === 0 || dirHandle === null}>
          Save{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
        </button>
        <button onClick={loadDemo}>Demo</button>
      </div>
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
  const setParam = useApp((s) => s.setParam);
  if (pipeline === null) return null;
  const params = allParams(pipeline);
  const audit = params.filter((p) => p.prov === "approximated");

  const edit = (name: string, prov: "measured" | "approximated" | "designed"): void => {
    const raw = window.prompt(
      prov === "measured" ? `Measured value for ${name}:` : `New value for ${name}:`,
    );
    if (raw === null || raw.trim() === "") return;
    try {
      setParam(name, parseLength(raw), prov);
    } catch (e) {
      useApp.getState().showToast((e as Error).message, "error");
    }
  };

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
                <button title="Edit value" onClick={() => edit(p.name, p.prov)}>
                  ✎
                </button>
                {p.prov !== "measured" && (
                  <button title="Record a measurement" onClick={() => edit(p.name, "measured")}>
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
          <strong>Measurements disagree</strong> (off by{" "}
          {formatLength(Math.round(Math.max(...c.violated.map((v) => v.residualInches)) * 64))}
          ). Suspects: {c.suspects.join(", ")}
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

  return null;
}

export default function App(): JSX.Element {
  const boot = useApp((s) => s.boot);
  useEffect(() => {
    boot();
  }, [boot]);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <Plan2D />
        <div className="sidebar">
          <SelectionPanel />
          <DiagnosticsPanel />
          <ParamsPanel />
          <div className="panel hint-panel">
            <p className="hint">
              <b>Select</b>: click walls/junctions, drag junctions, ⌫ deletes. <b>Wall</b>: click
              to chain walls, Esc ends. Scroll pans, pinch/⌘-scroll zooms.
            </p>
          </div>
        </div>
      </div>
      <Toast />
    </div>
  );
}
