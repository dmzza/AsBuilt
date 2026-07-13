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
  defaultMeasureRef,
  faceMeasureEndpoints,
  fixtureViews,
  formatLength,
  formatFaceRef,
  isCenterlineRef,
  junctionPos,
  levelOfKey,
  levelViews,
  openingViews,
  previewDiff,
  proposeMove,
  proposeMoveWall,
  s64FromInches,
  thicknessValue,
  type FaceRef,
  type Grade,
  type OpeningView,
  type Pipeline,
  type S64,
} from "../core";
import { useApp } from "../state/store";
import { CLICK_PX, hasArmedDrag } from "../ui/interaction";

export const GRADE_COLORS: Record<Grade, string> = {
  measured: "#1d4ed8",
  designed: "#7c3aed",
  approximated: "#b45309",
  drawn: "#6b7280",
};

/** The vellum sheet: everything drawn on the 2D canvas keys off this palette. */
export const SHEET = {
  paper: "#f5f3ec",
  grid: "#edebe0",
  gridMajor: "#e2dfd1",
  ink: "#35322b",
  hardware: "#8b8779", // junction rings, fixture outlines
  label: "#6d6a5f",
  select: "#2563eb",
  conflict: "#c22a2a",
};

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const SERIF = 'Georgia, "Times New Roman", serif';

interface View {
  cx: number; // world center, inches
  cy: number;
  ppi: number; // pixels per inch
}

/** sx/sy = pointer-down screen position: pointerup within CLICK_PX of it is a
 *  click (select only), never an edit. */
type DragState =
  | {
      kind: "junction";
      key: string;
      wx: number;
      wy: number;
      sx: number;
      sy: number;
      forceBreak: boolean;
    }
  | {
      kind: "wall";
      key: string;
      /** World position at pointer-down (for delta). */
      ox: number;
      oy: number;
      wx: number;
      wy: number;
      sx: number;
      sy: number;
      forceBreak: boolean;
    }
  | {
      kind: "opening";
      key: string;
      centerAlong: number;
      originAlong: number;
      sx: number;
      sy: number;
    }
  | { kind: "fixture"; key: string; wx: number; wy: number; sx: number; sy: number };

const JUNCTION_SNAP_PX = 12;
const GRID_INCH = 1; // drawing rounds to whole inches

function roundInch(v: number): S64 {
  return s64FromInches(Math.round(v));
}

/** ⌥/Alt, ⌘/Cmd, or Ctrl — any of these means "force-break hard constraints". */
function forceBreakFromEvent(e: {
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return e.altKey || e.metaKey || e.ctrlKey;
}

/** Debounced propose→solve for the ghost that shows "if I release here". */
function scheduleDragPreview(
  drag: Extract<DragState, { kind: "junction" } | { kind: "wall" }>,
  wx: number,
  wy: number,
  forceBreak: boolean,
  previewEdits: (propose: () => import("../core").TextEdit[]) => void,
): void {
  previewEdits(() => {
    const { project, branch } = useApp.getState();
    if (project === null) return [];
    if (drag.kind === "junction") {
      const p = proposeMove(
        project,
        branch,
        drag.key,
        { x: roundInch(wx), y: roundInch(wy) },
        { forceBreak },
      );
      if (p.kind === "refusal" || !p.verified) return [];
      return p.edits;
    }
    const dx = wx - drag.ox;
    const dy = wy - drag.oy;
    if (Math.hypot(dx, dy) < 0.05) return [];
    const p = proposeMoveWall(project, branch, drag.key, { x: dx, y: dy }, { forceBreak });
    if (p.kind === "refusal" || !p.verified) return [];
    return p.edits;
  });
}

export function Plan2D(): JSX.Element {
  const pipeline = useApp((s) => s.pipeline);
  const sceneEpoch = useApp((s) => s.sceneEpoch);
  const ghostPipeline = useApp((s) => s.ghostPipeline);
  const ghostOn = useApp((s) => s.ghost);
  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const pendingStart = useApp((s) => s.pendingStart);
  const measurePending = useApp((s) => s.measurePending);
  const select = useApp((s) => s.select);
  const dragJunction = useApp((s) => s.dragJunction);
  const dragWall = useApp((s) => s.dragWall);
  const placeWallPoint = useApp((s) => s.placeWallPoint);
  const cancelPending = useApp((s) => s.cancelPending);
  const deleteSelection = useApp((s) => s.deleteSelection);
  const setMeasurePending = useApp((s) => s.setMeasurePending);
  const openEditor = useApp((s) => s.openEditor);
  const previewEdits = useApp((s) => s.previewEdits);
  const clearPreview = useApp((s) => s.clearPreview);
  const placeOpening = useApp((s) => s.placeOpening);
  const moveOpening = useApp((s) => s.moveOpening);
  const placeFixture = useApp((s) => s.placeFixture);
  const moveFixture = useApp((s) => s.moveFixture);
  const level = useApp((s) => s.level);
  const preview = useApp((s) => s.preview);
  const highlight = useApp((s) => s.highlight);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ cx: 200, cy: 80, ppi: 2 });
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Becomes true only after pointer travel exceeds CLICK_PX. Clicks never arm. */
  const dragArmed = useRef(false);
  const [pan, setPan] = useState<{ px: number; py: number } | null>(null);
  const [cursor, setCursor] = useState<{ wx: number; wy: number } | null>(null);
  const fitted = useRef(false);
  const fittedEpoch = useRef(-1);

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

  // --- gather geometry (only the active level's statements draw on the sheet)
  const geometry = useMemo(() => {
    if (pipeline === null) return null;
    const levels = levelViews(pipeline);
    const onLevel = (key: string): boolean => levelOfKey(key, levels) === level;
    const thickness = new Map<string, number>();
    for (const [key, eff] of pipeline.resolved.effective) {
      if (eff.stmt.kind !== "walltype") continue;
      const i = pipeline.solution.system.varIndex.get(`t:${key}`);
      thickness.set(
        key,
        i !== undefined ? pipeline.solution.x[i]! : eff.stmt.thickness / 64,
      );
    }
    const walls: {
      key: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      th: number;
    }[] = [];
    const junctions: { key: string; x: number; y: number }[] = [];
    const spaces: { key: string; x: number; y: number }[] = [];
    const voids: { key: string; x: number; y: number; w: number; d: number }[] = [];
    const measures: {
      key: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      value: number; // s64
      adjacent: boolean;
      /** Face ref for label/hint; undefined = centerline. */
      ref?: FaceRef;
    }[] = [];
    const wallPairs = new Set<string>();
    const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const [key, eff] of pipeline.resolved.effective) {
      const s = eff.stmt;
      if (s.kind === "wall") {
        // a wall lives where its endpoints live
        if (!onLevel(s.from)) continue;
        const a = junctionPos(pipeline.solution, s.from);
        const b = junctionPos(pipeline.solution, s.to);
        if (a !== null && b !== null) {
          walls.push({ key, a, b, th: thickness.get(s.wallType) ?? 4.5 });
          wallPairs.add(pairKey(s.from, s.to));
        }
      } else if (s.kind === "junction") {
        if (!onLevel(key)) continue;
        const p = junctionPos(pipeline.solution, key);
        if (p !== null) junctions.push({ key, x: p.x, y: p.y });
      } else if (s.kind === "space") {
        if (!onLevel(key)) continue;
        spaces.push({ key, x: s.at.x / 64, y: s.at.y / 64 });
      } else if (s.kind === "void") {
        if (!onLevel(key)) continue;
        voids.push({ key, x: s.at.x / 64, y: s.at.y / 64, w: s.w / 64, d: s.d / 64 });
      }
    }
    // centroid for outward dimension offsets + face-measure interior bias
    let cx = 0;
    let cy = 0;
    for (const j of junctions) {
      cx += j.x;
      cy += j.y;
    }
    const centroid =
      junctions.length > 0
        ? { x: cx / junctions.length, y: cy / junctions.length }
        : { x: 0, y: 0 };

    const thicknessOf = (wt: string): number => thickness.get(wt) ?? 4.5;
    const getJ = (name: string): { x: number; y: number } | null =>
      junctionPos(pipeline.solution, name);

    for (const [key, eff] of pipeline.resolved.effective) {
      const s = eff.stmt;
      if (s.kind !== "meas") continue;
      if (!onLevel(s.a)) continue;
      // Face-ref meases land on the faces the tape hit, not junction centers.
      const ends = faceMeasureEndpoints(
        pipeline.resolved,
        getJ,
        thicknessOf,
        s.a,
        s.b,
        s.ref,
        centroid,
      );
      if (ends === null) continue;
      measures.push({
        key,
        a: ends.a,
        b: ends.b,
        value: s.value,
        adjacent: wallPairs.has(pairKey(s.a, s.b)),
        ref: isCenterlineRef(s.ref) ? undefined : s.ref,
      });
    }
    return { walls, junctions, spaces, voids, measures, centroid };
  }, [pipeline, level]);

  // the parent branch's walls on the same level, for the ghost overlay
  const parentWalls = useMemo(() => {
    if (!ghostOn || ghostPipeline === null) return [];
    const levels = levelViews(ghostPipeline);
    const thickness = new Map<string, number>();
    for (const [key, eff] of ghostPipeline.resolved.effective) {
      if (eff.stmt.kind === "walltype") thickness.set(key, eff.stmt.thickness / 64);
    }
    const walls: {
      key: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      th: number;
    }[] = [];
    for (const [key, eff] of ghostPipeline.resolved.effective) {
      const s = eff.stmt;
      if (s.kind !== "wall") continue;
      if (levelOfKey(s.from, levels) !== level) continue;
      const a = junctionPos(ghostPipeline.solution, s.from);
      const b = junctionPos(ghostPipeline.solution, s.to);
      if (a !== null && b !== null) {
        walls.push({ key, a, b, th: thickness.get(s.wallType) ?? 4.5 });
      }
    }
    return walls;
  }, [ghostOn, ghostPipeline, level]);

  // the hovered proposal's would-be geometry, diffed against the live model
  const previewGeom = useMemo(() => {
    if (pipeline === null || preview === null) return null;
    const diff = previewDiff(pipeline, preview);
    const nextLevels = levelViews(preview);
    const thickness = new Map<string, number>();
    for (const [key, eff] of preview.resolved.effective) {
      if (eff.stmt.kind !== "walltype") continue;
      thickness.set(
        key,
        thicknessValue(preview.solution, key) ?? eff.stmt.thickness / 64,
      );
    }
    const walls: {
      key: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      th: number;
    }[] = [];
    for (const key of diff.walls) {
      const eff = preview.resolved.effective.get(key);
      if (eff?.stmt.kind !== "wall") continue;
      if (levelOfKey(eff.stmt.from, nextLevels) !== level) continue;
      const a = junctionPos(preview.solution, eff.stmt.from);
      const b = junctionPos(preview.solution, eff.stmt.to);
      if (a !== null && b !== null) {
        walls.push({ key, a, b, th: thickness.get(eff.stmt.wallType) ?? 4.5 });
      }
    }
    const openKeys = new Set(diff.openings);
    const opens = openingViews(preview).filter((o) => {
      if (!openKeys.has(o.key)) return false;
      const wallEff = preview.resolved.effective.get(o.wall);
      return wallEff?.stmt.kind === "wall" && levelOfKey(wallEff.stmt.from, nextLevels) === level;
    });
    const fixKeys = new Set(diff.fixtures);
    const fixes = fixtureViews(preview).filter(
      (f) => fixKeys.has(f.key) && levelOfKey(f.key, nextLevels) === level,
    );
    // removed geometry gets struck through at its current position
    const curLevels = levelViews(pipeline);
    const curOpens = new Map(openingViews(pipeline).map((o) => [o.key, o]));
    const strikes: { key: string; a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    for (const key of diff.removed) {
      const eff = pipeline.resolved.effective.get(key);
      const s = eff?.stmt;
      if (s === undefined) continue;
      if (s.kind === "wall") {
        if (levelOfKey(s.from, curLevels) !== level) continue;
        const a = junctionPos(pipeline.solution, s.from);
        const b = junctionPos(pipeline.solution, s.to);
        if (a !== null && b !== null) strikes.push({ key, a, b });
      } else if (s.kind === "meas") {
        if (levelOfKey(s.a, curLevels) !== level) continue;
        const a = junctionPos(pipeline.solution, s.a);
        const b = junctionPos(pipeline.solution, s.b);
        if (a !== null && b !== null) strikes.push({ key, a, b });
      } else if (s.kind === "opening") {
        const o = curOpens.get(key);
        const wallEff = pipeline.resolved.effective.get(s.wall);
        if (
          o !== undefined &&
          wallEff?.stmt.kind === "wall" &&
          levelOfKey(wallEff.stmt.from, curLevels) === level
        ) {
          strikes.push({ key, a: o.jambA, b: o.jambB });
        }
      } else if (s.kind === "fixture") {
        if (levelOfKey(key, curLevels) !== level) continue;
        const x = s.at.x / 64;
        const y = s.at.y / 64;
        const hw = s.w / 128;
        const hd = s.d / 128;
        strikes.push({ key: `${key}:a`, a: { x: x - hw, y: y - hd }, b: { x: x + hw, y: y + hd } });
        strikes.push({ key: `${key}:b`, a: { x: x - hw, y: y + hd }, b: { x: x + hw, y: y - hd } });
      }
    }
    if (walls.length + opens.length + fixes.length + strikes.length === 0) return null;
    return { walls, opens, fixes, strikes };
  }, [pipeline, preview, level]);

  const grades = useMemo(
    () => (pipeline === null ? new Map<string, { grade: Grade }>() : allWallGrades(pipeline)),
    [pipeline],
  );

  // openings follow their host wall's level; fixtures live where their key says
  const openings = useMemo(() => {
    if (pipeline === null) return [];
    const levels = levelViews(pipeline);
    return openingViews(pipeline).filter((o) => {
      const wallEff = pipeline.resolved.effective.get(o.wall);
      if (wallEff?.stmt.kind !== "wall") return false;
      return levelOfKey(wallEff.stmt.from, levels) === level;
    });
  }, [pipeline, level]);
  const fixtures = useMemo(() => {
    if (pipeline === null) return [];
    const levels = levelViews(pipeline);
    return fixtureViews(pipeline).filter((f) => levelOfKey(f.key, levels) === level);
  }, [pipeline, level]);

  /** Nearest wall to a world point: distance and center-parameter along it. */
  const nearestWall = useCallback(
    (wx: number, wy: number): { key: string; along: number; dist: number } | null => {
      if (geometry === null) return null;
      let best: { key: string; along: number; dist: number } | null = null;
      for (const w of geometry.walls) {
        const vx = w.b.x - w.a.x;
        const vy = w.b.y - w.a.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((wx - w.a.x) * vx + (wy - w.a.y) * vy) / len2));
        const px = w.a.x + vx * t;
        const py = w.a.y + vy * t;
        const dist = Math.hypot(wx - px, wy - py);
        if (best === null || dist < best.dist) {
          best = { key: w.key, along: t * Math.sqrt(len2), dist };
        }
      }
      return best;
    },
    [geometry],
  );

  /** Recompute an opening's authored offset from a dropped center position. */
  const openingOffsetFromCenter = useCallback(
    (view: OpeningView, centerAlong: number): S64 | null => {
      if (pipeline === null || geometry === null) return null;
      const wallEff = pipeline.resolved.effective.get(view.wall);
      if (wallEff?.stmt.kind !== "wall") return null;
      const w = geometry.walls.find((g) => g.key === view.wall);
      if (w === undefined) return null;
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      let start = Math.max(0, Math.min(centerAlong - view.widthInches / 2, len - view.widthInches));
      start = Math.round(start);
      const off =
        view.anchor === wallEff.stmt.from ? start : Math.round(len - start - view.widthInches);
      return s64FromInches(Math.max(0, off));
    },
    [pipeline, geometry],
  );

  const suspects = useMemo(() => {
    const out = new Set<string>();
    if (pipeline === null) return out;
    for (const c of pipeline.solution.contradictions) {
      for (const s of c.suspects) out.add(s);
    }
    return out;
  }, [pipeline]);

  const suspectWalls = useMemo(() => {
    const out = new Set<string>();
    for (const s of suspects) {
      if (s.endsWith(".length")) out.add(s.slice(0, -".length".length));
      if (s.endsWith(".axis")) out.add(s.slice(0, -".axis".length));
    }
    return out;
  }, [suspects]);

  // --- fit / refit when sceneEpoch advances (demo reload, open folder).
  // Epoch is checked here — not in a separate reset effect — so identical
  // demo geometry still reframes after the user has panned.
  useEffect(() => {
    if (geometry === null || geometry.junctions.length === 0) return;
    if (fitted.current && fittedEpoch.current === sceneEpoch) return;
    fitted.current = true;
    fittedEpoch.current = sceneEpoch;
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
  }, [geometry, size, sceneEpoch]);

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
        // Cancel in-progress drag (including live ghost) and dismiss measure UI.
        clearPreview();
        useApp.getState().closeEditor();
        cancelPending();
        setMeasurePending(null);
        select(null);
        setDrag(null);
        dragArmed.current = false;
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelPending, select, deleteSelection, setMeasurePending, clearPreview]);

  // --- snapping helper: junctions first, then mid-wall T-join, then grid
  const snap = useCallback(
    (
      wx: number,
      wy: number,
    ): {
      end: { existing: string } | { onWall: string; x: S64; y: S64 } | { x: S64; y: S64 };
      wx: number;
      wy: number;
    } => {
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

        // Mid-wall snap → auto T-join split (not within ~3" of either endpoint).
        const wallTol = Math.max(tol, 10 / view.ppi);
        let bestWall: {
          key: string;
          d: number;
          x: number;
          y: number;
        } | null = null;
        for (const w of geometry.walls) {
          const vx = w.b.x - w.a.x;
          const vy = w.b.y - w.a.y;
          const len2 = vx * vx + vy * vy;
          if (len2 < 0.01) continue;
          const len = Math.sqrt(len2);
          let t = ((wx - w.a.x) * vx + (wy - w.a.y) * vy) / len2;
          t = Math.max(0, Math.min(1, t));
          const along = t * len;
          if (along < 3 || along > len - 3) continue; // leave corners to junction snap
          const px = w.a.x + vx * t;
          const py = w.a.y + vy * t;
          const d = Math.hypot(wx - px, wy - py);
          // Prefer a hit within the wall's half-thickness, else the pixel tol.
          const faceTol = Math.max(wallTol, w.th / 2 + 2 / view.ppi);
          if (d < faceTol && (bestWall === null || d < bestWall.d)) {
            bestWall = { key: w.key, d, x: px, y: py };
          }
        }
        if (bestWall !== null) {
          return {
            end: {
              onWall: bestWall.key,
              x: roundInch(bestWall.x),
              y: roundInch(bestWall.y),
            },
            wx: bestWall.x,
            wy: bestWall.y,
          };
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
    // Free point or mid-wall T-join target (both carry sketch x/y in s64).
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
        // Axis constraint only when the free end isn't locked to existing topology.
        const lockEnd = "existing" in s.end || "onWall" in s.end;
        placeWallPoint(s.end, lockEnd ? undefined : snapped.axis);
      }
      return;
    }

    if (tool === "measure") {
      // background click abandons a half-made measurement
      if (e.target === e.currentTarget) setMeasurePending(null);
      return;
    }

    if (tool === "door" || tool === "window") {
      const hit = nearestWall(wx, wy);
      if (hit !== null && hit.dist < 18 / view.ppi) {
        placeOpening(hit.key, hit.along);
      }
      return;
    }

    if (tool === "fixture") {
      placeFixture({ x: roundInch(wx), y: roundInch(wy) });
      return;
    }

    // select tool: background press starts a pan
    setPan({ px: e.clientX, py: e.clientY });
    if (e.target === e.currentTarget) select(null);
  };

  const onJunctionDown = (key: string, e: ReactPointerEvent): void => {
    if (tool === "measure") {
      e.stopPropagation();
      if (measurePending === null) {
        setMeasurePending(key);
      } else if (measurePending !== key && pipeline !== null) {
        const face = defaultMeasureRef(pipeline, { a: measurePending, b: key });
        openEditor({
          target: { kind: "measure-pair", a: measurePending, b: key, face },
          anchor: { x: e.clientX, y: e.clientY },
          initial: "",
          label: `Measured ${measurePending} → ${key}`,
        });
      }
      return;
    }
    startJunctionDrag(key, e);
  };

  const onWallDown = (key: string, e: ReactPointerEvent): void => {
    if (tool === "measure") {
      e.stopPropagation();
      const face =
        pipeline !== null ? defaultMeasureRef(pipeline, { wall: key }) : undefined;
      openEditor({
        target: { kind: "measure-wall", wall: key, face },
        anchor: { x: e.clientX, y: e.clientY },
        initial: "",
        label: `Measured length of ${key}`,
      });
      return;
    }
    if (tool !== "select") return;
    e.stopPropagation();
    select(key);
    const svg = svgRef.current;
    if (svg === null) return;
    const r = svg.getBoundingClientRect();
    const { wx, wy } = toWorld(e.clientX - r.left, e.clientY - r.top);
    dragArmed.current = false;
    setDrag({
      kind: "wall",
      key,
      ox: wx,
      oy: wy,
      wx,
      wy,
      sx: e.clientX,
      sy: e.clientY,
      forceBreak: forceBreakFromEvent(e),
    });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { wx, wy } = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    setCursor({ wx, wy });

    if (drag !== null) {
      // Arm only after real travel. Sub-threshold jitter never updates the
      // preview and never commits on pointerup — so a click on a fixture edge
      // cannot yank it to the pointer (which is offset from the object center).
      if (!dragArmed.current) {
        if (
          !hasArmedDrag({ x: drag.sx, y: drag.sy }, { x: e.clientX, y: e.clientY }, CLICK_PX)
        ) {
          return;
        }
        dragArmed.current = true;
      }
      if (drag.kind === "opening") {
        const view = openings.find((o) => o.key === drag.key);
        const hit = view !== undefined ? nearestWallAlong(geometry, view.wall, wx, wy) : null;
        if (hit !== null) setDrag({ ...drag, centerAlong: hit });
      } else if (drag.kind === "wall" || drag.kind === "junction") {
        const forceBreak = drag.forceBreak || forceBreakFromEvent(e);
        const rw = Math.round(wx);
        const rh = Math.round(wy);
        setDrag({ ...drag, wx: rw, wy: rh, forceBreak });
        // Live preview of release result (debounced solve in the store).
        scheduleDragPreview(drag, rw, rh, forceBreak, previewEdits);
      } else {
        setDrag({ ...drag, wx: Math.round(wx), wy: Math.round(wy) });
      }
      return;
    }
    if (pan !== null && tool === "select") {
      const dx = e.clientX - pan.px;
      const dy = e.clientY - pan.py;
      setPan({ px: e.clientX, py: e.clientY });
      setView((v) => ({ ...v, cx: v.cx - dx / v.ppi, cy: v.cy + dy / v.ppi }));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag !== null) {
      const armed =
        dragArmed.current ||
        hasArmedDrag({ x: drag.sx, y: drag.sy }, { x: e.clientX, y: e.clientY }, CLICK_PX);
      dragArmed.current = false;
      // Drop live preview; commit path re-solves for real.
      clearPreview();
      // Commit only when the gesture crossed the threshold (during move or on
      // a flick that skipped intermediate moves). Never commit a click — even
      // when release is offset from the object center.
      if (armed) {
        const rect = e.currentTarget.getBoundingClientRect();
        const { wx, wy } = toWorld(e.clientX - rect.left, e.clientY - rect.top);
        const forceBreak =
          drag.kind === "junction" || drag.kind === "wall"
            ? drag.forceBreak || forceBreakFromEvent(e)
            : false;
        if (drag.kind === "junction") {
          const moved = Math.hypot(wx - drag.wx, wy - drag.wy) > 0.01 ? { wx, wy } : drag;
          dragJunction(
            drag.key,
            { x: roundInch(moved.wx), y: roundInch(moved.wy) },
            { forceBreak },
          );
        } else if (drag.kind === "wall") {
          const end = Math.hypot(wx - drag.wx, wy - drag.wy) > 0.01 ? { wx, wy } : drag;
          const dx = end.wx - drag.ox;
          const dy = end.wy - drag.oy;
          if (Math.hypot(dx, dy) > 0.05) {
            dragWall(drag.key, { x: dx, y: dy }, { forceBreak });
          }
        } else if (drag.kind === "fixture") {
          const moved = Math.hypot(wx - drag.wx, wy - drag.wy) > 0.01 ? { wx, wy } : drag;
          moveFixture(drag.key, { x: roundInch(moved.wx), y: roundInch(moved.wy) });
        } else {
          const view = openings.find((o) => o.key === drag.key);
          const along = nearestWallAlong(geometry, view?.wall ?? "", wx, wy) ?? drag.centerAlong;
          if (view !== undefined && Math.abs(along - drag.originAlong) > 1 / 64) {
            const off = openingOffsetFromCenter(view, along);
            if (off !== null) moveOpening(drag.key, off);
          }
        }
      }
      setDrag(null);
    }
    setPan(null);
  };

  const startJunctionDrag = (key: string, e: ReactPointerEvent): void => {
    if (tool !== "select") return;
    e.stopPropagation();
    select(key);
    const p = geometry?.junctions.find((j) => j.key === key);
    if (p === undefined) return;
    dragArmed.current = false;
    setDrag({
      kind: "junction",
      key,
      wx: p.x,
      wy: p.y,
      sx: e.clientX,
      sy: e.clientY,
      forceBreak: forceBreakFromEvent(e),
    });
  };

  const startOpeningDrag = (key: string, e: ReactPointerEvent): void => {
    if (tool !== "select") return;
    e.stopPropagation();
    select(key);
    const view = openings.find((o) => o.key === key);
    if (view === undefined || geometry === null) return;
    const w = geometry.walls.find((g) => g.key === view.wall);
    if (w === undefined) return;
    const midX = (view.jambA.x + view.jambB.x) / 2;
    const midY = (view.jambA.y + view.jambB.y) / 2;
    const along = Math.hypot(midX - w.a.x, midY - w.a.y);
    dragArmed.current = false;
    setDrag({
      kind: "opening",
      key,
      centerAlong: along,
      originAlong: along,
      sx: e.clientX,
      sy: e.clientY,
    });
  };

  const startFixtureDrag = (key: string, e: ReactPointerEvent): void => {
    if (tool !== "select") return;
    e.stopPropagation();
    select(key);
    const f = fixtures.find((v) => v.key === key);
    if (f === undefined) return;
    dragArmed.current = false;
    setDrag({
      kind: "fixture",
      key,
      wx: f.x,
      wy: f.y,
      sx: e.clientX,
      sy: e.clientY,
    });
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
          dragArmed.current = false;
          setDrag(null);
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
            stroke={g.major ? SHEET.gridMajor : SHEET.grid}
            strokeWidth={1}
          />
        ))}

        {/* parent ghost: where the walls stand on the sheet underneath */}
        {parentWalls.map((w) => {
          const a = toScreen(w.a.x, w.a.y);
          const b = toScreen(w.b.x, w.b.y);
          return (
            <g key={`ghost:${w.key}`} pointerEvents="none">
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={SHEET.hardware}
                strokeOpacity={0.18}
                strokeWidth={Math.max(w.th * view.ppi, 2)}
              />
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={SHEET.hardware}
                strokeOpacity={0.7}
                strokeWidth={1}
                strokeDasharray="6 4"
              />
            </g>
          );
        })}

        {/* floor voids (stairwells): dashed opening with cross, drafting-style */}
        {geometry.voids.map((v) => {
          const p0 = toScreen(v.x, v.y + v.d);
          const p1 = toScreen(v.x + v.w, v.y);
          const w = p1.x - p0.x;
          const h = p1.y - p0.y;
          return (
            <g key={v.key} pointerEvents="none">
              <rect
                x={p0.x}
                y={p0.y}
                width={w}
                height={h}
                fill="none"
                stroke={SHEET.hardware}
                strokeWidth={1.2}
                strokeDasharray="7 4"
              />
              <line
                x1={p0.x}
                y1={p0.y}
                x2={p0.x + w}
                y2={p0.y + h}
                stroke={SHEET.hardware}
                strokeWidth={0.8}
                strokeDasharray="7 4"
              />
              <line
                x1={p0.x + w}
                y1={p0.y}
                x2={p0.x}
                y2={p0.y + h}
                stroke={SHEET.hardware}
                strokeWidth={0.8}
                strokeDasharray="7 4"
              />
              <text
                x={p0.x + w / 2}
                y={p0.y + h / 2 - 4}
                textAnchor="middle"
                fontSize={10}
                fontFamily={MONO}
                fill={SHEET.label}
              >
                open to below
              </text>
            </g>
          );
        })}

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
                stroke={isSuspect ? SHEET.conflict : isSel ? SHEET.select : SHEET.ink}
                strokeWidth={Math.max(w.th * view.ppi, 2)}
                strokeLinecap="square"
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => onWallDown(w.key, e)}
              />
            </g>
          );
        })}

        {/* openings: gap + door swing / window lines */}
        {openings.map((o) => {
          const w = geometry.walls.find((g) => g.key === o.wall);
          if (w === undefined) return null;
          const a = toScreen(o.jambA.x, o.jambA.y);
          const b = toScreen(o.jambB.x, o.jambB.y);
          const isSel = selection === o.key;
          const gapW = Math.max(w.th * view.ppi + 2, 4);
          const color = o.overflow ? SHEET.conflict : isSel ? SHEET.select : SHEET.ink;
          // door swing: hinge at jambA, leaf into the room (toward centroid)
          let swing: JSX.Element | null = null;
          if (o.opKind === "door") {
            let nx = -o.dir.y;
            let ny = o.dir.x;
            const midX = (o.jambA.x + o.jambB.x) / 2;
            const midY = (o.jambA.y + o.jambB.y) / 2;
            if (nx * (geometry.centroid.x - midX) + ny * (geometry.centroid.y - midY) < 0) {
              nx = -nx;
              ny = -ny;
            }
            const leafEnd = toScreen(
              o.jambA.x + nx * o.widthInches,
              o.jambA.y + ny * o.widthInches,
            );
            const r = Math.hypot(b.x - a.x, b.y - a.y);
            const sweep = (leafEnd.x - a.x) * (b.y - a.y) - (leafEnd.y - a.y) * (b.x - a.x);
            swing = (
              <>
                <line x1={a.x} y1={a.y} x2={leafEnd.x} y2={leafEnd.y} stroke={color} strokeWidth={1.2} />
                <path
                  d={`M ${leafEnd.x} ${leafEnd.y} A ${r} ${r} 0 0 ${sweep > 0 ? 1 : 0} ${b.x} ${b.y}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={0.8}
                  strokeDasharray="3 3"
                />
              </>
            );
          }
          return (
            <g
              key={o.key}
              data-key={o.key}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => startOpeningDrag(o.key, e)}
            >
              {/* the gap: erase the wall between the jambs */}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={SHEET.paper} strokeWidth={gapW} />
              {o.opKind === "window" ? (
                <>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1.2} />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={color}
                    strokeWidth={Math.max(gapW * 0.55, 3)}
                    opacity={0.18}
                  />
                </>
              ) : (
                swing
              )}
              {isSel && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2563eb" strokeWidth={2} opacity={0.6} strokeDasharray="4 3" />
              )}
            </g>
          );
        })}

        {/* fixtures */}
        {fixtures.map((f) => {
          const rotated = f.rot === 90 || f.rot === 270;
          const fw = rotated ? f.d : f.w;
          const fd = rotated ? f.w : f.d;
          const p = toScreen(f.x - fw / 2, f.y + fd / 2);
          const isSel = selection === f.key;
          return (
            <g
              key={f.key}
              data-key={f.key}
              style={{ cursor: "grab" }}
              onPointerDown={(e) => startFixtureDrag(f.key, e)}
            >
              <rect
                x={p.x}
                y={p.y}
                width={fw * view.ppi}
                height={fd * view.ppi}
                fill={isSel ? "#dbeafe" : "#eeece2"}
                stroke={isSel ? SHEET.select : SHEET.hardware}
                strokeWidth={1.2}
                rx={2}
              />
              {fw * view.ppi > 30 && (
                <text
                  x={p.x + (fw * view.ppi) / 2}
                  y={p.y + (fd * view.ppi) / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill={SHEET.label}
                  fontFamily={MONO}
                  style={{ userSelect: "none", pointerEvents: "none" }}
                >
                  {f.fixKind}
                </text>
              )}
            </g>
          );
        })}

        {/* door/window placement ghost */}
        {(tool === "door" || tool === "window") &&
          cursor !== null &&
          (() => {
            const hit = nearestWall(cursor.wx, cursor.wy);
            if (hit === null || hit.dist > 18 / view.ppi) return null;
            const w = geometry.walls.find((g) => g.key === hit.key);
            if (w === undefined) return null;
            const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
            const ux = (w.b.x - w.a.x) / len;
            const uy = (w.b.y - w.a.y) / len;
            const gw = tool === "door" ? 32 : 36;
            const start = Math.max(0, Math.min(hit.along - gw / 2, len - gw));
            const a = toScreen(w.a.x + ux * start, w.a.y + uy * start);
            const b = toScreen(w.a.x + ux * (start + gw), w.a.y + uy * (start + gw));
            return (
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#2563eb"
                strokeWidth={Math.max(w.th * view.ppi, 6)}
                opacity={0.45}
                style={{ pointerEvents: "none" }}
              />
            );
          })()}

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
              fontFamily={MONO}
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
              fill="#8a8577"
              fontFamily={SERIF}
              letterSpacing="0.06em"
              fontStyle="italic"
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {label}
            </text>
          );
        })}

        {/* measured dimensions */}
        {geometry.measures.map((m) => (
          <DimensionGraphic
            key={m.key}
            m={m}
            toScreen={toScreen}
            ppi={view.ppi}
            centroid={geometry.centroid}
            selected={selection === m.key}
            suspect={suspects.has(m.key)}
            onDown={(e) => {
              if (tool !== "select") return;
              e.stopPropagation();
              select(m.key);
            }}
          />
        ))}

        {/* inspector-hover highlight: the geometry a hovered row refers to */}
        {highlight.length > 0 && (
          <g data-highlight pointerEvents="none">
            {highlight.flatMap((key) => {
              const out: JSX.Element[] = [];
              const w = geometry.walls.find((g) => g.key === key);
              if (w !== undefined) {
                const a = toScreen(w.a.x, w.a.y);
                const b = toScreen(w.b.x, w.b.y);
                out.push(
                  <line
                    key={`hl:${key}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SHEET.select}
                    strokeOpacity={0.3}
                    strokeWidth={Math.max(w.th * view.ppi, 2) + 8}
                    strokeLinecap="round"
                  />,
                );
              }
              const j = geometry.junctions.find((g) => g.key === key);
              if (j !== undefined) {
                const s = toScreen(j.x, j.y);
                out.push(
                  <circle
                    key={`hl:${key}`}
                    cx={s.x}
                    cy={s.y}
                    r={11}
                    fill={SHEET.select}
                    fillOpacity={0.25}
                  />,
                );
              }
              const m = geometry.measures.find((g) => g.key === key);
              if (m !== undefined) {
                const a = toScreen(m.a.x, m.a.y);
                const b = toScreen(m.b.x, m.b.y);
                out.push(
                  <line
                    key={`hl:${key}:m`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SHEET.select}
                    strokeOpacity={0.3}
                    strokeWidth={9}
                    strokeLinecap="round"
                  />,
                );
              }
              const o = openings.find((g) => g.key === key);
              if (o !== undefined) {
                const a = toScreen(o.jambA.x, o.jambA.y);
                const b = toScreen(o.jambB.x, o.jambB.y);
                out.push(
                  <line
                    key={`hl:${key}:o`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SHEET.select}
                    strokeOpacity={0.35}
                    strokeWidth={12}
                    strokeLinecap="round"
                  />,
                );
              }
              const f = fixtures.find((g) => g.key === key);
              if (f !== undefined) {
                const rotated = f.rot === 90 || f.rot === 270;
                const fw = rotated ? f.d : f.w;
                const fd = rotated ? f.w : f.d;
                const p = toScreen(f.x - fw / 2, f.y + fd / 2);
                out.push(
                  <rect
                    key={`hl:${key}:f`}
                    x={p.x - 3}
                    y={p.y - 3}
                    width={fw * view.ppi + 6}
                    height={fd * view.ppi + 6}
                    fill={SHEET.select}
                    fillOpacity={0.2}
                    rx={4}
                  />,
                );
              }
              return out;
            })}
          </g>
        )}

        {/* hover preview: the hypothetical model, diffed against the live one */}
        {previewGeom !== null && (
          <g data-preview pointerEvents="none">
            {previewGeom.strikes.map((s) => {
              const a = toScreen(s.a.x, s.a.y);
              const b = toScreen(s.b.x, s.b.y);
              return (
                <line
                  key={`rm:${s.key}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={SHEET.conflict}
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  strokeOpacity={0.8}
                />
              );
            })}
            {previewGeom.walls.map((w) => {
              const a = toScreen(w.a.x, w.a.y);
              const b = toScreen(w.b.x, w.b.y);
              return (
                <g key={`pv:${w.key}`}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SHEET.select}
                    strokeOpacity={0.16}
                    strokeWidth={Math.max(w.th * view.ppi, 2)}
                  />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SHEET.select}
                    strokeWidth={1.5}
                    strokeDasharray="2 3"
                  />
                </g>
              );
            })}
            {previewGeom.opens.map((o) => {
              const a = toScreen(o.jambA.x, o.jambA.y);
              const b = toScreen(o.jambB.x, o.jambB.y);
              return (
                <line
                  key={`pv:${o.key}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={SHEET.select}
                  strokeOpacity={0.5}
                  strokeWidth={7}
                />
              );
            })}
            {previewGeom.fixes.map((f) => {
              const rotated = f.rot === 90 || f.rot === 270;
              const fw = rotated ? f.d : f.w;
              const fd = rotated ? f.w : f.d;
              const p = toScreen(f.x - fw / 2, f.y + fd / 2);
              return (
                <rect
                  key={`pv:${f.key}`}
                  x={p.x}
                  y={p.y}
                  width={fw * view.ppi}
                  height={fd * view.ppi}
                  fill={SHEET.select}
                  fillOpacity={0.08}
                  stroke={SHEET.select}
                  strokeWidth={1.5}
                  strokeDasharray="2 3"
                  rx={2}
                />
              );
            })}
          </g>
        )}

        {/* junctions */}
        {geometry.junctions.map((j) => {
          const s = toScreen(j.x, j.y);
          const isSel = selection === j.key;
          const isPendingMeas = measurePending === j.key;
          return (
            <circle
              key={j.key}
              cx={s.x}
              cy={s.y}
              r={isSel || isPendingMeas ? 6 : 4.5}
              fill={isSel ? SHEET.select : isPendingMeas ? "#1d4ed8" : SHEET.paper}
              stroke={isSel || isPendingMeas ? "#1d4ed8" : SHEET.hardware}
              strokeWidth={1.5}
              style={{
                cursor: tool === "select" ? "grab" : "crosshair",
              }}
              onPointerDown={(e) => onJunctionDown(j.key, e)}
            />
          );
        })}

        {/* measure tool ghost */}
        {tool === "measure" &&
          measurePending !== null &&
          cursor !== null &&
          (() => {
            const p = geometry.junctions.find((j) => j.key === measurePending);
            if (p === undefined) return null;
            const a = toScreen(p.x, p.y);
            const b = toScreen(cursor.wx, cursor.wy);
            return (
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#1d4ed8"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                style={{ pointerEvents: "none" }}
              />
            );
          })()}

        {/* drag ghosts */}
        {drag !== null &&
          drag.kind !== "opening" &&
          (() => {
            const s = toScreen(drag.wx, drag.wy);
            return (
              <g style={{ pointerEvents: "none" }}>
                <circle cx={s.x} cy={s.y} r={6} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 3" />
                <text x={s.x + 10} y={s.y - 10} fontSize={11} fill="#2563eb" fontFamily={MONO}>
                  {formatLength(roundInch(drag.wx))}, {formatLength(roundInch(drag.wy))}
                </text>
              </g>
            );
          })()}
        {drag !== null &&
          drag.kind === "opening" &&
          (() => {
            const ov = openings.find((o) => o.key === drag.key);
            const w = geometry.walls.find((g) => g.key === ov?.wall);
            if (ov === undefined || w === undefined) return null;
            const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
            const ux = (w.b.x - w.a.x) / len;
            const uy = (w.b.y - w.a.y) / len;
            const start = Math.max(
              0,
              Math.min(drag.centerAlong - ov.widthInches / 2, len - ov.widthInches),
            );
            const a = toScreen(w.a.x + ux * start, w.a.y + uy * start);
            const b = toScreen(
              w.a.x + ux * (start + ov.widthInches),
              w.a.y + uy * (start + ov.widthInches),
            );
            return (
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#2563eb"
                strokeWidth={Math.max(w.th * view.ppi, 6)}
                opacity={0.5}
                style={{ pointerEvents: "none" }}
              />
            );
          })()}

        {/* wall tool ghost (drawing) */}
        {ghost !== null &&
          pendingAnchor !== null &&
          (() => {
            const a = toScreen(pendingAnchor.wx, pendingAnchor.wy);
            const b = toScreen(ghost.wx, ghost.wy);
            const len = Math.hypot(ghost.wx - pendingAnchor.wx, ghost.wy - pendingAnchor.wy);
            return (
              <g style={{ pointerEvents: "none" }}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2563eb" strokeWidth={2} strokeDasharray="6 4" />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 8} fontSize={11} fill="#2563eb" fontFamily={MONO} textAnchor="middle">
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

/** Project a world point onto a specific wall; inches along it from its from-end. */
function nearestWallAlong(
  geometry: {
    walls: { key: string; a: { x: number; y: number }; b: { x: number; y: number } }[];
  } | null,
  wallKey: string,
  wx: number,
  wy: number,
): number | null {
  if (geometry === null) return null;
  const w = geometry.walls.find((g) => g.key === wallKey);
  if (w === undefined) return null;
  const vx = w.b.x - w.a.x;
  const vy = w.b.y - w.a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 0.01) return null;
  const t = Math.max(0, Math.min(1, ((wx - w.a.x) * vx + (wy - w.a.y) * vy) / len2));
  return t * Math.sqrt(len2);
}

interface DimProps {
  m: {
    key: string;
    a: { x: number; y: number };
    b: { x: number; y: number };
    value: number;
    adjacent: boolean;
    ref?: FaceRef;
  };
  toScreen: (wx: number, wy: number) => { x: number; y: number };
  ppi: number;
  centroid: { x: number; y: number };
  selected: boolean;
  suspect: boolean;
  onDown: (e: ReactPointerEvent) => void;
}

/**
 * A measured dimension. Wall-adjacent pairs render as offset architectural
 * dimension lines (extension lines + oblique ticks, outside the building);
 * anything else (diagonals, cross-room spans) renders as a direct dashed line.
 */
function DimensionGraphic({ m, toScreen, ppi, centroid, selected, suspect, onDown }: DimProps): JSX.Element | null {
  const color = suspect ? SHEET.conflict : GRADE_COLORS.measured;
  const width = selected ? 2 : 1.2;
  const faceLabel =
    m.ref === undefined
      ? ""
      : m.ref.a === m.ref.b && m.ref.a === "inner"
        ? " int"
        : m.ref.a === m.ref.b && m.ref.a === "outer"
          ? " ext"
          : ` ${formatFaceRef(m.ref)}`;
  const text = `${formatLength(m.value)}${faceLabel}`;

  const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
  if (len < 0.01) return null;
  const ux = (m.b.x - m.a.x) / len;
  const uy = (m.b.y - m.a.y) / len;

  if (!m.adjacent) {
    const a = toScreen(m.a.x, m.a.y);
    const b = toScreen(m.b.x, m.b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return (
      <g style={{ cursor: "pointer" }} onPointerDown={onDown}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width} strokeDasharray="6 4" />
        <text
          x={mid.x}
          y={mid.y - 6}
          textAnchor="middle"
          fontSize={11}
          fill={color}
          fontFamily={MONO}
          stroke={SHEET.paper}
          strokeWidth={3}
          paintOrder="stroke"
          style={{ userSelect: "none" }}
        >
          {text}
        </text>
      </g>
    );
  }

  // outward normal: away from the plan centroid
  let nx = -uy;
  let ny = ux;
  const midW = { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 };
  if (nx * (midW.x - centroid.x) + ny * (midW.y - centroid.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  // Face-ref endpoints already sit on the wall face; keep the dim line a
  // readable offset beyond that face (still outside the building by default).
  const off = 26 / ppi;
  const ext = 4 / ppi;
  const a1 = toScreen(m.a.x + nx * off, m.a.y + ny * off);
  const b1 = toScreen(m.b.x + nx * off, m.b.y + ny * off);
  const a0 = toScreen(m.a.x, m.a.y);
  const b0 = toScreen(m.b.x, m.b.y);
  const aExt = toScreen(m.a.x + nx * (off + ext), m.a.y + ny * (off + ext));
  const bExt = toScreen(m.b.x + nx * (off + ext), m.b.y + ny * (off + ext));
  const textPos = toScreen(
    (m.a.x + m.b.x) / 2 + nx * (off + 10 / ppi),
    (m.a.y + m.b.y) / 2 + ny * (off + 10 / ppi),
  );
  // oblique architectural ticks at each end of the dimension line
  const tick = 5;
  const tx = (ux + nx) * 0.7071;
  const ty = (uy + ny) * 0.7071;
  return (
    <g style={{ cursor: "pointer" }} onPointerDown={onDown}>
      {/* Extension lines start at the face points the tape actually hit. */}
      <line x1={a0.x} y1={a0.y} x2={aExt.x} y2={aExt.y} stroke={color} strokeWidth={0.8} />
      <line x1={b0.x} y1={b0.y} x2={bExt.x} y2={bExt.y} stroke={color} strokeWidth={0.8} />
      <line x1={a1.x} y1={a1.y} x2={b1.x} y2={b1.y} stroke={color} strokeWidth={width} />
      <line x1={a1.x - tx * tick} y1={a1.y + ty * tick} x2={a1.x + tx * tick} y2={a1.y - ty * tick} stroke={color} strokeWidth={width} />
      <line x1={b1.x - tx * tick} y1={b1.y + ty * tick} x2={b1.x + tx * tick} y2={b1.y - ty * tick} stroke={color} strokeWidth={width} />
      <text
        x={textPos.x}
        y={textPos.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={11}
        fontWeight={600}
        fill={color}
        fontFamily={MONO}
        stroke={SHEET.paper}
        strokeWidth={3}
        paintOrder="stroke"
        style={{ userSelect: "none" }}
      >
        {text}
      </text>
    </g>
  );
}
