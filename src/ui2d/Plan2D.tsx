import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  allWallGrades,
  formatLength,
  junctionPos,
  s64FromInches,
  type Grade,
  type Pipeline,
  type S64,
} from "../core";
import { useApp } from "../state/store";

export const GRADE_COLORS: Record<Grade, string> = {
  measured: "#1d4ed8",
  designed: "#7c3aed",
  approximated: "#b45309",
  drawn: "#6b7280",
};

interface View {
  cx: number; // world center, inches
  cy: number;
  ppi: number; // pixels per inch
}

interface DragState {
  junction: string;
  wx: number; // current world position of the ghost
  wy: number;
}

const JUNCTION_SNAP_PX = 12;
const GRID_INCH = 1; // drawing rounds to whole inches

function roundInch(v: number): S64 {
  return s64FromInches(Math.round(v));
}

export function Plan2D(): JSX.Element {
  const pipeline = useApp((s) => s.pipeline);
  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const pendingStart = useApp((s) => s.pendingStart);
  const select = useApp((s) => s.select);
  const dragJunction = useApp((s) => s.dragJunction);
  const placeWallPoint = useApp((s) => s.placeWallPoint);
  const cancelPending = useApp((s) => s.cancelPending);
  const deleteSelection = useApp((s) => s.deleteSelection);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ cx: 200, cy: 80, ppi: 2 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pan, setPan] = useState<{ px: number; py: number } | null>(null);
  const [cursor, setCursor] = useState<{ wx: number; wy: number } | null>(null);
  const fitted = useRef(false);

  // --- size tracking
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // --- projections
  const toScreen = useCallback(
    (wx: number, wy: number): { x: number; y: number } => ({
      x: (wx - view.cx) * view.ppi + size.w / 2,
      y: (view.cy - wy) * view.ppi + size.h / 2,
    }),
    [view, size],
  );
  const toWorld = useCallback(
    (sx: number, sy: number): { wx: number; wy: number } => ({
      wx: (sx - size.w / 2) / view.ppi + view.cx,
      wy: view.cy - (sy - size.h / 2) / view.ppi,
    }),
    [view, size],
  );

  // --- gather geometry
  const geometry = useMemo(() => {
    if (pipeline === null) return null;
    const thickness = new Map<string, number>();
    for (const [key, eff] of pipeline.resolved.effective) {
      if (eff.stmt.kind === "walltype") thickness.set(key, eff.stmt.thickness / 64);
    }
    const walls: {
      key: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      th: number;
    }[] = [];
    const junctions: { key: string; x: number; y: number }[] = [];
    const spaces: { key: string; x: number; y: number }[] = [];
    for (const [key, eff] of pipeline.resolved.effective) {
      const s = eff.stmt;
      if (s.kind === "wall") {
        const a = junctionPos(pipeline.solution, s.from);
        const b = junctionPos(pipeline.solution, s.to);
        if (a !== null && b !== null) {
          walls.push({ key, a, b, th: thickness.get(s.wallType) ?? 4.5 });
        }
      } else if (s.kind === "junction") {
        const p = junctionPos(pipeline.solution, key);
        if (p !== null) junctions.push({ key, x: p.x, y: p.y });
      } else if (s.kind === "space") {
        spaces.push({ key, x: s.at.x / 64, y: s.at.y / 64 });
      }
    }
    return { walls, junctions, spaces };
  }, [pipeline]);

  const grades = useMemo(
    () => (pipeline === null ? new Map<string, { grade: Grade }>() : allWallGrades(pipeline)),
    [pipeline],
  );

  const suspectWalls = useMemo(() => {
    const out = new Set<string>();
    if (pipeline === null) return out;
    for (const c of pipeline.solution.contradictions) {
      for (const s of c.suspects) {
        if (s.endsWith(".length")) out.add(s.slice(0, -".length".length));
        if (s.endsWith(".axis")) out.add(s.slice(0, -".axis".length));
      }
    }
    return out;
  }, [pipeline]);

  // --- initial fit
  useEffect(() => {
    if (fitted.current || geometry === null || geometry.junctions.length === 0) return;
    fitted.current = true;
    const xs = geometry.junctions.map((j) => j.x);
    const ys = geometry.junctions.map((j) => j.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const bw = Math.max(maxX - minX, 60);
    const bh = Math.max(maxY - minY, 60);
    const ppi = Math.min(size.w / bw, size.h / bh) * 0.7;
    setView({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, ppi: Math.max(ppi, 0.5) });
  }, [geometry, size]);

  // --- wheel: pan (trackpad scroll) or zoom (pinch / ctrl+wheel)
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = svg.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        setView((v) => {
          const factor = Math.exp(-e.deltaY * 0.01);
          const ppi = Math.min(Math.max(v.ppi * factor, 0.2), 60);
          // keep the world point under the cursor fixed
          const wx = (sx - size.w / 2) / v.ppi + v.cx;
          const wy = v.cy - (sy - size.h / 2) / v.ppi;
          return {
            ppi,
            cx: wx - (sx - size.w / 2) / ppi,
            cy: wy + (sy - size.h / 2) / ppi,
          };
        });
      } else {
        setView((v) => ({
          ...v,
          cx: v.cx + e.deltaX / v.ppi,
          cy: v.cy - e.deltaY / v.ppi,
        }));
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [size]);

  // --- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.key === "Escape") {
        cancelPending();
        select(null);
        setDrag(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelPending, select, deleteSelection]);

  // --- snapping helper
  const snap = useCallback(
    (wx: number, wy: number): { end: { existing: string } | { x: S64; y: S64 }; wx: number; wy: number } => {
      if (geometry !== null) {
        const tol = JUNCTION_SNAP_PX / view.ppi;
        let best: { key: string; d: number; x: number; y: number } | null = null;
        for (const j of geometry.junctions) {
          const d = Math.hypot(j.x - wx, j.y - wy);
          if (d < tol && (best === null || d < best.d)) {
            best = { key: j.key, d, x: j.x, y: j.y };
          }
        }
        if (best !== null) {
          return { end: { existing: best.key }, wx: best.x, wy: best.y };
        }
      }
      const rx = Math.round(wx / GRID_INCH) * GRID_INCH;
      const ry = Math.round(wy / GRID_INCH) * GRID_INCH;
      return { end: { x: roundInch(rx), y: roundInch(ry) }, wx: rx, wy: ry };
    },
    [geometry, view.ppi],
  );

  /** Anchor of the pending wall (world), for ghost + axis snap. */
  const pendingAnchor = useMemo((): { wx: number; wy: number } | null => {
    if (pendingStart === null || pipeline === null) return null;
    if ("existing" in pendingStart) {
      const p = junctionPos(pipeline.solution, pendingStart.existing);
      return p === null ? null : { wx: p.x, wy: p.y };
    }
    return { wx: pendingStart.x / 64, wy: pendingStart.y / 64 };
  }, [pendingStart, pipeline]);

  /** Apply axis snap of the second wall point against the anchor. */
  const axisSnap = useCallback(
    (wx: number, wy: number): { wx: number; wy: number; axis?: "h" | "v" } => {
      if (pendingAnchor === null) return { wx, wy };
      const dx = Math.abs(wx - pendingAnchor.wx);
      const dy = Math.abs(wy - pendingAnchor.wy);
      if (dx >= dy * 4) return { wx, wy: pendingAnchor.wy, axis: "h" };
      if (dy >= dx * 4) return { wx: pendingAnchor.wx, wy, axis: "v" };
      return { wx, wy };
    },
    [pendingAnchor],
  );

  // --- pointer handlers
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { wx, wy } = toWorld(e.clientX - rect.left, e.clientY - rect.top);

    if (tool === "wall") {
      if (pendingStart === null) {
        const s = snap(wx, wy);
        placeWallPoint(s.end);
      } else {
        const snapped = axisSnap(wx, wy);
        const s = snap(snapped.wx, snapped.wy);
        // an existing-junction end keeps its own position; axis only applies
        // when the geometry is really aligned after snapping
        placeWallPoint(s.end, "existing" in s.end ? undefined : snapped.axis);
      }
      return;
    }

    // select tool: background press starts a pan
    setPan({ px: e.clientX, py: e.clientY });
    if (e.target === e.currentTarget) select(null);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { wx, wy } = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    setCursor({ wx, wy });

    if (drag !== null) {
      setDrag({ ...drag, wx: Math.round(wx), wy: Math.round(wy) });
      return;
    }
    if (pan !== null && tool === "select") {
      const dx = e.clientX - pan.px;
      const dy = e.clientY - pan.py;
      setPan({ px: e.clientX, py: e.clientY });
      setView((v) => ({ ...v, cx: v.cx - dx / v.ppi, cy: v.cy + dy / v.ppi }));
    }
  };

  const onPointerUp = (): void => {
    if (drag !== null) {
      dragJunction(drag.junction, { x: roundInch(drag.wx), y: roundInch(drag.wy) });
      setDrag(null);
    }
    setPan(null);
  };

  const startJunctionDrag = (key: string, e: ReactPointerEvent): void => {
    if (tool !== "select") return;
    e.stopPropagation();
    select(key);
    const p = geometry?.junctions.find((j) => j.key === key);
    if (p !== undefined) setDrag({ junction: key, wx: p.x, wy: p.y });
  };

  // --- grid lines
  const grid = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    const step = view.ppi * 12 >= 18 ? 12 : view.ppi * 48 >= 18 ? 48 : 96;
    const w0 = toWorld(0, size.h);
    const w1 = toWorld(size.w, 0);
    const startX = Math.floor(w0.wx / step) * step;
    const startY = Math.floor(w0.wy / step) * step;
    for (let x = startX; x <= w1.wx; x += step) {
      const s = toScreen(x, 0);
      lines.push({ x1: s.x, y1: 0, x2: s.x, y2: size.h, major: x % 48 === 0 });
    }
    for (let y = startY; y <= w1.wy; y += step) {
      const s = toScreen(0, y);
      lines.push({ x1: 0, y1: s.y, x2: size.w, y2: s.y, major: y % 48 === 0 });
    }
    return lines;
  }, [view, size, toScreen, toWorld]);

  if (pipeline === null || geometry === null) {
    return (
      <div ref={wrapRef} className="plan-wrap">
        <div className="plan-empty">No model loaded</div>
      </div>
    );
  }

  // ghost second point for the wall tool
  const ghost =
    tool === "wall" && pendingAnchor !== null && cursor !== null
      ? axisSnap(cursor.wx, cursor.wy)
      : null;

  return (
    <div ref={wrapRef} className="plan-wrap">
      <svg
        ref={svgRef}
        className={`plan ${tool === "wall" ? "tool-wall" : ""}`}
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setPan(null);
          setCursor(null);
        }}
      >
        {/* grid */}
        {grid.map((g, i) => (
          <line
            key={i}
            x1={g.x1}
            y1={g.y1}
            x2={g.x2}
            y2={g.y2}
            stroke={g.major ? "#e4e4e7" : "#f1f1f4"}
            strokeWidth={1}
          />
        ))}

        {/* walls */}
        {geometry.walls.map((w) => {
          const a = toScreen(w.a.x, w.a.y);
          const b = toScreen(w.b.x, w.b.y);
          const isSel = selection === w.key;
          const isSuspect = suspectWalls.has(w.key);
          return (
            <g key={w.key}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={isSuspect ? "#dc2626" : isSel ? "#2563eb" : "#3f3f46"}
                strokeWidth={Math.max(w.th * view.ppi, 2)}
                strokeLinecap="square"
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => {
                  if (tool !== "select") return;
                  e.stopPropagation();
                  select(w.key);
                }}
              />
            </g>
          );
        })}

        {/* wall length labels */}
        {geometry.walls.map((w) => {
          const lenPx = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * view.ppi;
          if (lenPx < 48) return null;
          const midX = (w.a.x + w.b.x) / 2;
          const midY = (w.a.y + w.b.y) / 2;
          const ux = (w.b.x - w.a.x) / (lenPx / view.ppi);
          const uy = (w.b.y - w.a.y) / (lenPx / view.ppi);
          const off = w.th / 2 + 14 / view.ppi;
          const s = toScreen(midX - uy * off, midY + ux * off);
          const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
          const grade = grades.get(w.key)?.grade ?? "drawn";
          const text = formatLength(Math.round(len * 16) * 4);
          return (
            <text
              key={`${w.key}:label`}
              x={s.x}
              y={s.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill={GRADE_COLORS[grade]}
              fontStyle={grade === "measured" || grade === "designed" ? "normal" : "italic"}
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {grade === "approximated" || grade === "drawn" ? `(${text})` : text}
            </text>
          );
        })}

        {/* space labels */}
        {geometry.spaces.map((sp) => {
          const s = toScreen(sp.x, sp.y);
          const label = sp.key.endsWith(".space") ? sp.key.slice(0, -".space".length) : sp.key;
          return (
            <text
              key={sp.key}
              x={s.x}
              y={s.y}
              textAnchor="middle"
              fontSize={13}
              fill="#71717a"
              fontStyle="italic"
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {label}
            </text>
          );
        })}

        {/* junctions */}
        {geometry.junctions.map((j) => {
          const s = toScreen(j.x, j.y);
          const isSel = selection === j.key;
          return (
            <circle
              key={j.key}
              cx={s.x}
              cy={s.y}
              r={isSel ? 6 : 4.5}
              fill={isSel ? "#2563eb" : "#ffffff"}
              stroke={isSel ? "#1d4ed8" : "#71717a"}
              strokeWidth={1.5}
              style={{ cursor: tool === "select" ? "grab" : "crosshair" }}
              onPointerDown={(e) => startJunctionDrag(j.key, e)}
            />
          );
        })}

        {/* junction drag ghost */}
        {drag !== null &&
          (() => {
            const s = toScreen(drag.wx, drag.wy);
            return (
              <g style={{ pointerEvents: "none" }}>
                <circle cx={s.x} cy={s.y} r={6} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 3" />
                <text x={s.x + 10} y={s.y - 10} fontSize={11} fill="#2563eb">
                  {formatLength(roundInch(drag.wx))}, {formatLength(roundInch(drag.wy))}
                </text>
              </g>
            );
          })()}

        {/* wall tool ghost */}
        {ghost !== null &&
          pendingAnchor !== null &&
          (() => {
            const a = toScreen(pendingAnchor.wx, pendingAnchor.wy);
            const b = toScreen(ghost.wx, ghost.wy);
            const len = Math.hypot(ghost.wx - pendingAnchor.wx, ghost.wy - pendingAnchor.wy);
            return (
              <g style={{ pointerEvents: "none" }}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2563eb" strokeWidth={2} strokeDasharray="6 4" />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 8} fontSize={11} fill="#2563eb" textAnchor="middle">
                  {formatLength(Math.round(len * 16) * 4)}
                  {ghost.axis !== undefined ? ` (${ghost.axis})` : ""}
                </text>
              </g>
            );
          })()}
      </svg>
    </div>
  );
}
