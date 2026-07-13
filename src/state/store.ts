import { create } from "zustand";
import {
  applyEdits,
  createConcept,
  defaultMeasureRef,
  layerMap,
  loadProject,
  parseLength,
  proposeAddFixture,
  proposeAddOpening,
  proposeAddWall,
  proposeDelete,
  proposeDropOrphan,
  proposeEditMeas,
  proposeMeasure,
  proposeMove,
  proposeMoveWall,
  proposeReparent,
  proposeResolveMasked,
  proposeSetFixture,
  proposeSetOpeningOffset,
  proposeSetParam,
  resolveAndSolve,
  type FaceEnd,
  type Pipeline,
  type Point,
  type Project,
  type Provenance,
  type S64,
  type TextEdit,
  type WallEndpoint,
} from "../core";
import { DEMO_BRANCH, DEMO_FILES } from "../demo";
import * as persist from "../persist";

export type Tool = "select" | "wall" | "measure" | "door" | "window" | "fixture";

export type ViewMode = "2d" | "3d" | "split";

export type EditorTarget =
  | { kind: "param"; name: string; prov: Provenance }
  | { kind: "param-measure"; name: string }
  | { kind: "measure-wall"; wall: string; face?: FaceEnd }
  | { kind: "measure-pair"; a: string; b: string; face?: FaceEnd }
  | { kind: "meas-edit"; name: string };

export interface EditorState {
  target: EditorTarget;
  /** Screen position to anchor the popover near. */
  anchor: { x: number; y: number };
  initial: string;
  label: string;
}

interface Snapshot {
  files: Record<string, string>;
  branch: string;
}

const HISTORY_CAP = 100;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface AppState {
  project: Project | null;
  branch: string;
  pipeline: Pipeline | null;
  pipelineError: string | null;
  /** Parent branch's solved model, for the ghost overlay (null on the root). */
  ghostPipeline: Pipeline | null;
  ghost: boolean;
  /** Hypothetical model: current files + a hovered proposal, solved scratch. */
  preview: Pipeline | null;
  /** Keys whose geometry lights up on the canvas (inspector hover). */
  highlight: string[];
  dirHandle: FileSystemDirectoryHandle | null;
  dirty: Record<string, true>;
  selection: string | null;
  tool: Tool;
  viewMode: ViewMode;
  /** Active level namespace for the 2D sheet; null = ground. */
  level: string | null;
  wallType: string;
  pendingStart: WallEndpoint | null;
  measurePending: string | null;
  editor: EditorState | null;
  past: Snapshot[];
  future: Snapshot[];
  toast: { message: string; kind: "info" | "error"; at: number } | null;
  /** Bumped on demo load / folder open so 2D/3D views know to refit the camera. */
  sceneEpoch: number;

  boot(): void;
  loadDemo(): void;
  openFolder(): Promise<void>;
  saveAll(): Promise<void>;
  setBranch(branch: string): void;
  reparent(newParent: string): void;
  toggleGhost(): void;
  /** Debounced: solve `propose()` on the side and show it as a ghost. */
  previewEdits(propose: () => TextEdit[]): void;
  clearPreview(): void;
  setHighlight(keys: string[]): void;
  /** Preview the value editor's current (uncommitted) text. */
  previewEditorValue(raw: string): void;
  resolveMasked(name: string, action: "keep" | "adopt"): void;
  dropOrphan(key: string): void;
  setTool(tool: Tool): void;
  setWallType(wallType: string): void;
  select(key: string | null): void;
  runEdits(edits: TextEdit[]): void;
  dragJunction(
    name: string,
    target: { x: S64; y: S64 },
    opts?: { forceBreak?: boolean },
  ): void;
  /** Translate a wall by a world-space delta (inches). */
  dragWall(
    name: string,
    deltaInches: { x: number; y: number },
    opts?: { forceBreak?: boolean },
  ): void;
  placeWallPoint(end: WallEndpoint, axis?: "h" | "v"): void;
  cancelPending(): void;
  deleteSelection(): void;
  newConcept(name: string): void;
  setParam(name: string, value: S64, prov: Provenance): void;
  setMeasurePending(junction: string | null): void;
  setViewMode(mode: ViewMode): void;
  setLevel(ns: string | null): void;
  placeOpening(wall: string, centerAlongInches: number): void;
  moveOpening(name: string, offset: S64): void;
  placeFixture(at: Point): void;
  moveFixture(name: string, at: Point): void;
  rotateFixture(name: string): void;
  openEditor(editor: EditorState): void;
  closeEditor(): void;
  /** Change measure face without wiping the typed draft value. */
  setMeasureFace(face: FaceEnd): void;
  /** Parse and apply the editor's entered value. Returns an error message or null. */
  commitEditor(raw: string): string | null;
  undo(): void;
  redo(): void;
  showToast(message: string, kind?: "info" | "error"): void;
}

function compute(project: Project, branch: string): {
  pipeline: Pipeline | null;
  pipelineError: string | null;
  ghostPipeline: Pipeline | null;
} {
  try {
    if (!project.layers.has(branch)) {
      const first = [...project.layers.keys()][0];
      if (first === undefined) {
        return { pipeline: null, pipelineError: "no layers", ghostPipeline: null };
      }
      branch = first;
    }
    const pipeline = resolveAndSolve(layerMap(project), branch);
    const parent = project.layers.get(branch)!.parsed.header.parent;
    let ghostPipeline: Pipeline | null = null;
    if (parent !== null && project.layers.has(parent)) {
      try {
        ghostPipeline = resolveAndSolve(layerMap(project), parent);
      } catch {
        ghostPipeline = null; // parent may not solve; ghost is best-effort
      }
    }
    return { pipeline, pipelineError: null, ghostPipeline };
  } catch (e) {
    return { pipeline: null, pipelineError: (e as Error).message, ghostPipeline: null };
  }
}

/** Text edits for a value-editor target; shared by commit and hover preview. */
function editsForTarget(
  project: Project,
  branch: string,
  target: EditorTarget,
  value: S64,
): TextEdit[] {
  switch (target.kind) {
    case "param":
      return proposeSetParam(
        project,
        branch,
        target.name,
        value,
        target.prov,
        target.prov === "measured" ? today() : undefined,
      );
    case "param-measure":
      return proposeSetParam(project, branch, target.name, value, "measured", today());
    case "measure-wall":
      return proposeMeasure(
        project,
        branch,
        { wall: target.wall },
        value,
        today(),
        target.face,
      );
    case "measure-pair":
      return proposeMeasure(
        project,
        branch,
        { a: target.a, b: target.b },
        value,
        today(),
        target.face,
      );
    case "meas-edit":
      return proposeEditMeas(project, branch, target.name, value, today());
  }
}

/** Hover + drag previews share this; short enough to feel live, long enough
 *  that force-break (multi solve) doesn't thrash every pointer pixel. */
const PREVIEW_DEBOUNCE_MS = 50;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

function firstWallType(project: Project): string {
  for (const [, l] of project.layers) {
    for (const s of l.parsed.stmts) {
      if (s.kind === "walltype") return s.name;
    }
  }
  return "int_2x4";
}

export const useApp = create<AppState>((set, get) => ({
  project: null,
  branch: "asbuilt",
  pipeline: null,
  pipelineError: null,
  ghostPipeline: null,
  ghost: true,
  preview: null,
  highlight: [],
  dirHandle: null,
  dirty: {},
  selection: null,
  tool: "select",
  viewMode: "2d",
  level: null,
  wallType: "int_2x4",
  pendingStart: null,
  measurePending: null,
  editor: null,
  past: [],
  future: [],
  toast: null,
  sceneEpoch: 0,

  boot() {
    const saved = persist.restore();
    const files = saved?.files ?? DEMO_FILES;
    const branch = saved?.branch ?? DEMO_BRANCH;
    try {
      const project = loadProject(files);
      set({
        project,
        branch: project.layers.has(branch) ? branch : [...project.layers.keys()][0]!,
        wallType: firstWallType(project),
        ...compute(project, branch),
      });
    } catch (e) {
      // corrupted autosave: fall back to demo
      const project = loadProject(DEMO_FILES);
      set({
        project,
        branch: DEMO_BRANCH,
        wallType: firstWallType(project),
        ...compute(project, DEMO_BRANCH),
        toast: { message: (e as Error).message, kind: "error", at: Date.now() },
      });
    }
  },

  loadDemo() {
    const project = loadProject(DEMO_FILES);
    set({
      project,
      branch: DEMO_BRANCH,
      dirHandle: null,
      dirty: {},
      selection: null,
      pendingStart: null,
      measurePending: null,
      editor: null,
      past: [],
      future: [],
      tool: "select",
      level: null,
      preview: null,
      highlight: [],
      wallType: firstWallType(project),
      sceneEpoch: get().sceneEpoch + 1,
      ...compute(project, DEMO_BRANCH),
    });
    persist.autosave(project.files, DEMO_BRANCH);
  },

  async openFolder() {
    try {
      const { handle, files } = await persist.openFolder();
      if (Object.keys(files).length === 0) {
        get().showToast("No .abl files in that folder", "error");
        return;
      }
      const project = loadProject(files);
      const branch = project.layers.has("asbuilt")
        ? "asbuilt"
        : [...project.layers.keys()][0]!;
      set({
        project,
        branch,
        dirHandle: handle,
        dirty: {},
        selection: null,
        pendingStart: null,
        measurePending: null,
        editor: null,
        past: [],
        future: [],
        level: null,
        preview: null,
        highlight: [],
        wallType: firstWallType(project),
        sceneEpoch: get().sceneEpoch + 1,
        ...compute(project, branch),
      });
      persist.autosave(project.files, branch);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        get().showToast(`Open failed: ${(e as Error).message}`, "error");
      }
    }
  },

  async saveAll() {
    const { project, dirHandle, dirty } = get();
    if (project === null) return;
    if (dirHandle === null) {
      get().showToast("No folder open (autosaved to browser storage)", "info");
      return;
    }
    try {
      for (const path of Object.keys(dirty)) {
        const text = project.files.get(path);
        if (text !== undefined) await persist.writeFile(dirHandle, path, text);
      }
      set({ dirty: {} });
      get().showToast("Saved", "info");
    } catch (e) {
      get().showToast(`Save failed: ${(e as Error).message}`, "error");
    }
  },

  setBranch(branch) {
    const { project } = get();
    if (project === null) return;
    if (previewTimer !== undefined) {
      clearTimeout(previewTimer);
      previewTimer = undefined;
    }
    set({
      branch,
      selection: null,
      pendingStart: null,
      measurePending: null,
      editor: null,
      preview: null,
      highlight: [],
      level: null,
      ...compute(project, branch),
    });
    persist.autosave(project.files, branch);
  },

  reparent(newParent) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      get().runEdits(proposeReparent(project, branch, newParent));
    } catch (e) {
      get().showToast(`Re-parent failed: ${(e as Error).message}`, "error");
    }
  },

  toggleGhost() {
    set({ ghost: !get().ghost });
  },

  previewEdits(propose) {
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      const { project, branch } = get();
      if (project === null) return;
      try {
        const edits = propose();
        if (edits.length === 0) {
          set({ preview: null });
          return;
        }
        const next = applyEdits(project, edits);
        set({ preview: resolveAndSolve(layerMap(next), branch) });
      } catch {
        // previews are best-effort; errors surface when the edit is committed
        set({ preview: null });
      }
    }, PREVIEW_DEBOUNCE_MS);
  },

  clearPreview() {
    if (previewTimer !== undefined) {
      clearTimeout(previewTimer);
      previewTimer = undefined;
    }
    if (get().preview !== null) set({ preview: null });
  },

  setHighlight(keys) {
    set({ highlight: keys });
  },

  previewEditorValue(raw) {
    const { editor, project, branch } = get();
    if (editor === null || project === null) {
      get().clearPreview();
      return;
    }
    let value: S64;
    try {
      value = parseLength(raw);
    } catch {
      get().clearPreview();
      return;
    }
    const target = editor.target;
    get().previewEdits(() => editsForTarget(get().project!, branch, target, value));
  },

  resolveMasked(name, action) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      get().runEdits(proposeResolveMasked(project, branch, name, action));
    } catch (e) {
      get().showToast(`Resolve failed: ${(e as Error).message}`, "error");
    }
  },

  dropOrphan(key) {
    const { project, branch, selection } = get();
    if (project === null) return;
    try {
      const edits = proposeDropOrphan(project, branch, key);
      if (selection === key) set({ selection: null });
      get().runEdits(edits);
    } catch (e) {
      get().showToast(`Remove failed: ${(e as Error).message}`, "error");
    }
  },

  setTool(tool) {
    set({ tool, pendingStart: null, measurePending: null });
  },

  setWallType(wallType) {
    set({ wallType });
  },

  select(key) {
    set({ selection: key });
  },

  runEdits(edits) {
    const { project, branch, dirty, past } = get();
    if (project === null || edits.length === 0) return;
    try {
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      const snapshot: Snapshot = { files: Object.fromEntries(project.files), branch };
      const next = applyEdits(project, edits);
      const touched: Record<string, true> = { ...dirty };
      for (const e of edits) touched[e.file] = true;
      set({
        project: next,
        dirty: touched,
        past: [...past.slice(-HISTORY_CAP + 1), snapshot],
        future: [],
        preview: null,
        ...compute(next, branch),
      });
      persist.autosave(next.files, branch);
    } catch (e) {
      get().showToast(`Edit failed: ${(e as Error).message}`, "error");
    }
  },

  dragJunction(name, target, opts) {
    const { project, branch } = get();
    if (project === null) return;
    const proposal = proposeMove(project, branch, name, target, opts);
    if (proposal.kind === "refusal") {
      get().showToast(
        proposal.blockers.length > 0
          ? `Locked by ${proposal.blockers.join(", ")}`
          : proposal.message,
        "error",
      );
      return;
    }
    if (!proposal.verified) {
      get().showToast("Move has no clean edit; nothing changed", "error");
      return;
    }
    if (proposal.edits.length > 0) get().runEdits(proposal.edits);
    if (proposal.broke !== undefined && proposal.broke.length > 0) {
      get().showToast(
        `Broke ${proposal.broke.join(", ")} — check Review if measurements disagree`,
        "info",
      );
    }
  },

  dragWall(name, deltaInches, opts) {
    const { project, branch } = get();
    if (project === null) return;
    const proposal = proposeMoveWall(project, branch, name, deltaInches, opts);
    if (proposal.kind === "refusal") {
      get().showToast(
        proposal.blockers.length > 0
          ? `Locked by ${proposal.blockers.join(", ")}`
          : proposal.message,
        "error",
      );
      return;
    }
    if (!proposal.verified) {
      get().showToast("Move has no clean edit; nothing changed", "error");
      return;
    }
    if (proposal.edits.length > 0) get().runEdits(proposal.edits);
    if (proposal.broke !== undefined && proposal.broke.length > 0) {
      get().showToast(
        `Broke ${proposal.broke.join(", ")} — check Review if measurements disagree`,
        "info",
      );
    }
  },

  placeWallPoint(end, axis) {
    const { pendingStart, project, branch, wallType } = get();
    if (project === null) return;
    if (pendingStart === null) {
      set({ pendingStart: end });
      return;
    }
    try {
      const proposal = proposeAddWall(project, branch, {
        a: pendingStart,
        b: end,
        wallType,
        axis,
        ns: get().level ?? undefined,
      });
      get().runEdits(proposal.edits);
      // chain: next wall starts at this wall's end junction
      set({
        pendingStart: { existing: proposal.junctions[1]! },
        selection: proposal.wall,
      });
    } catch (e) {
      get().showToast(`Draw failed: ${(e as Error).message}`, "error");
      set({ pendingStart: null });
    }
  },

  cancelPending() {
    set({ pendingStart: null });
  },

  deleteSelection() {
    const { project, branch, selection, pipeline } = get();
    if (project === null || selection === null || pipeline === null) return;
    const eff = pipeline.resolved.effective.get(selection);
    if (eff === undefined) return;
    if (
      eff.stmt.kind !== "wall" &&
      eff.stmt.kind !== "junction" &&
      eff.stmt.kind !== "meas" &&
      eff.stmt.kind !== "opening" &&
      eff.stmt.kind !== "fixture"
    ) {
      get().showToast("This can't be deleted directly", "info");
      return;
    }
    try {
      const edits = proposeDelete(project, branch, selection);
      set({ selection: null });
      get().runEdits(edits);
    } catch (e) {
      get().showToast(`Delete failed: ${(e as Error).message}`, "error");
    }
  },

  newConcept(name) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      const next = createConcept(project, name, branch);
      const dirty = { ...get().dirty, [`concepts/${name}.abl`]: true as const };
      set({ project: next, branch: name, dirty, ...compute(next, name) });
      persist.autosave(next.files, name);
    } catch (e) {
      get().showToast((e as Error).message, "error");
    }
  },

  setParam(name, value, prov) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      const edits = proposeSetParam(
        project,
        branch,
        name,
        value,
        prov,
        prov === "measured" ? today() : undefined,
      );
      get().runEdits(edits);
    } catch (e) {
      get().showToast(`Set failed: ${(e as Error).message}`, "error");
    }
  },

  setMeasurePending(junction) {
    set({ measurePending: junction });
  },

  setViewMode(mode) {
    set({ viewMode: mode });
  },

  setLevel(ns) {
    set({ level: ns, selection: null, pendingStart: null, measurePending: null, preview: null, highlight: [] });
  },

  placeOpening(wall, centerAlongInches) {
    const { project, branch, tool } = get();
    if (project === null || (tool !== "door" && tool !== "window")) return;
    try {
      const { edits, name } = proposeAddOpening(project, branch, {
        wall,
        opKind: tool,
        centerAlong: centerAlongInches,
      });
      get().runEdits(edits);
      set({ selection: name });
    } catch (e) {
      get().showToast(`Place failed: ${(e as Error).message}`, "error");
    }
  },

  moveOpening(name, offset) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      get().runEdits(proposeSetOpeningOffset(project, branch, name, offset));
    } catch (e) {
      get().showToast(`Move failed: ${(e as Error).message}`, "error");
    }
  },

  placeFixture(at) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      const { edits, name } = proposeAddFixture(project, branch, {
        at,
        ns: get().level ?? undefined,
      });
      get().runEdits(edits);
      set({ selection: name, tool: "select" });
    } catch (e) {
      get().showToast(`Place failed: ${(e as Error).message}`, "error");
    }
  },

  moveFixture(name, at) {
    const { project, branch } = get();
    if (project === null) return;
    try {
      get().runEdits(proposeSetFixture(project, branch, name, { at }));
    } catch (e) {
      get().showToast(`Move failed: ${(e as Error).message}`, "error");
    }
  },

  rotateFixture(name) {
    const { project, branch, pipeline } = get();
    if (project === null || pipeline === null) return;
    const eff = pipeline.resolved.effective.get(name);
    if (eff?.stmt.kind !== "fixture") return;
    const next = ((eff.stmt.rot + 90) % 360) as 0 | 90 | 180 | 270;
    try {
      get().runEdits(proposeSetFixture(project, branch, name, { rot: next }));
    } catch (e) {
      get().showToast(`Rotate failed: ${(e as Error).message}`, "error");
    }
  },

  openEditor(editor) {
    // Fill in a face-ref default for measure targets that predate the field
    // (callers should set face; this is a safety net for partial targets).
    const target = editor.target;
    const pipeline = get().pipeline;
    if (
      pipeline !== null &&
      (target.kind === "measure-wall" || target.kind === "measure-pair") &&
      (target as { face?: FaceEnd }).face === undefined
    ) {
      const face =
        target.kind === "measure-wall"
          ? defaultMeasureRef(pipeline, { wall: target.wall })
          : defaultMeasureRef(pipeline, { a: target.a, b: target.b });
      set({ editor: { ...editor, target: { ...target, face } } });
      return;
    }
    set({ editor });
  },

  closeEditor() {
    get().clearPreview();
    set({ editor: null, measurePending: null });
  },

  setMeasureFace(face) {
    const editor = get().editor;
    if (editor === null) return;
    if (editor.target.kind !== "measure-wall" && editor.target.kind !== "measure-pair") {
      return;
    }
    // Patch face in place — recreating the editor would wipe the draft via useEffect.
    set({ editor: { ...editor, target: { ...editor.target, face } } });
  },

  commitEditor(raw) {
    const { editor, project, branch } = get();
    if (editor === null || project === null) return null;
    let value: S64;
    try {
      value = parseLength(raw);
    } catch (e) {
      return (e as Error).message;
    }
    try {
      const edits = editsForTarget(project, branch, editor.target, value);
      get().clearPreview();
      set({ editor: null, measurePending: null });
      get().runEdits(edits);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },

  undo() {
    const { past, future, project, branch } = get();
    const prev = past[past.length - 1];
    if (prev === undefined || project === null) return;
    try {
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      const restored = loadProject(prev.files);
      set({
        project: restored,
        branch: prev.branch,
        past: past.slice(0, -1),
        future: [...future, { files: Object.fromEntries(project.files), branch }],
        selection: null,
        editor: null,
        measurePending: null,
        preview: null,
        highlight: [],
        dirty: markAllDirty(prev.files),
        ...compute(restored, prev.branch),
      });
      persist.autosave(restored.files, prev.branch);
    } catch (e) {
      get().showToast(`Undo failed: ${(e as Error).message}`, "error");
    }
  },

  redo() {
    const { past, future, project, branch } = get();
    const next = future[future.length - 1];
    if (next === undefined || project === null) return;
    try {
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      const restored = loadProject(next.files);
      set({
        project: restored,
        branch: next.branch,
        future: future.slice(0, -1),
        past: [...past, { files: Object.fromEntries(project.files), branch }],
        selection: null,
        editor: null,
        measurePending: null,
        preview: null,
        highlight: [],
        dirty: markAllDirty(next.files),
        ...compute(restored, next.branch),
      });
      persist.autosave(restored.files, next.branch);
    } catch (e) {
      get().showToast(`Redo failed: ${(e as Error).message}`, "error");
    }
  },

  showToast(message, kind = "info") {
    set({ toast: { message, kind, at: Date.now() } });
  },
}));

/** After undo/redo we can't know which files changed vs disk: mark all dirty. */
function markAllDirty(files: Record<string, string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const path of Object.keys(files)) out[path] = true;
  return out;
}
