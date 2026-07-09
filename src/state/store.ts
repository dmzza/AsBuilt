import { create } from "zustand";
import {
  applyEdits,
  createConcept,
  layerMap,
  loadProject,
  parseLength,
  proposeAddWall,
  proposeDelete,
  proposeEditMeas,
  proposeMeasure,
  proposeMove,
  proposeSetParam,
  resolveAndSolve,
  type Pipeline,
  type Project,
  type Provenance,
  type S64,
  type TextEdit,
  type WallEndpoint,
} from "../core";
import { DEMO_BRANCH, DEMO_FILES } from "../demo";
import * as persist from "../persist";

export type Tool = "select" | "wall" | "measure";

export type EditorTarget =
  | { kind: "param"; name: string; prov: Provenance }
  | { kind: "param-measure"; name: string }
  | { kind: "measure-wall"; wall: string }
  | { kind: "measure-pair"; a: string; b: string }
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
  dirHandle: FileSystemDirectoryHandle | null;
  dirty: Record<string, true>;
  selection: string | null;
  tool: Tool;
  wallType: string;
  pendingStart: WallEndpoint | null;
  measurePending: string | null;
  editor: EditorState | null;
  past: Snapshot[];
  future: Snapshot[];
  toast: { message: string; kind: "info" | "error"; at: number } | null;

  boot(): void;
  loadDemo(): void;
  openFolder(): Promise<void>;
  saveAll(): Promise<void>;
  setBranch(branch: string): void;
  setTool(tool: Tool): void;
  setWallType(wallType: string): void;
  select(key: string | null): void;
  runEdits(edits: TextEdit[]): void;
  dragJunction(name: string, target: { x: S64; y: S64 }): void;
  placeWallPoint(end: WallEndpoint, axis?: "h" | "v"): void;
  cancelPending(): void;
  deleteSelection(): void;
  newConcept(name: string): void;
  setParam(name: string, value: S64, prov: Provenance): void;
  setMeasurePending(junction: string | null): void;
  openEditor(editor: EditorState): void;
  closeEditor(): void;
  /** Parse and apply the editor's entered value. Returns an error message or null. */
  commitEditor(raw: string): string | null;
  undo(): void;
  redo(): void;
  showToast(message: string, kind?: "info" | "error"): void;
}

function compute(project: Project, branch: string): {
  pipeline: Pipeline | null;
  pipelineError: string | null;
} {
  try {
    if (!project.layers.has(branch)) {
      const first = [...project.layers.keys()][0];
      if (first === undefined) return { pipeline: null, pipelineError: "no layers" };
      branch = first;
    }
    return { pipeline: resolveAndSolve(layerMap(project), branch), pipelineError: null };
  } catch (e) {
    return { pipeline: null, pipelineError: (e as Error).message };
  }
}

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
  dirHandle: null,
  dirty: {},
  selection: null,
  tool: "select",
  wallType: "int_2x4",
  pendingStart: null,
  measurePending: null,
  editor: null,
  past: [],
  future: [],
  toast: null,

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
      wallType: firstWallType(project),
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
        wallType: firstWallType(project),
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
    set({ branch, selection: null, pendingStart: null, ...compute(project, branch) });
    persist.autosave(project.files, branch);
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
      const snapshot: Snapshot = { files: Object.fromEntries(project.files), branch };
      const next = applyEdits(project, edits);
      const touched: Record<string, true> = { ...dirty };
      for (const e of edits) touched[e.file] = true;
      set({
        project: next,
        dirty: touched,
        past: [...past.slice(-HISTORY_CAP + 1), snapshot],
        future: [],
        ...compute(next, branch),
      });
      persist.autosave(next.files, branch);
    } catch (e) {
      get().showToast(`Edit failed: ${(e as Error).message}`, "error");
    }
  },

  dragJunction(name, target) {
    const { project, branch } = get();
    if (project === null) return;
    const proposal = proposeMove(project, branch, name, target);
    if (proposal.kind === "refusal") {
      get().showToast(
        proposal.blockers.length > 0
          ? `Locked by measured: ${proposal.blockers.join(", ")}`
          : proposal.message,
        "error",
      );
      return;
    }
    if (!proposal.verified) {
      // never apply an edit that doesn't do what the drag asked
      get().showToast("Move has no clean edit; nothing changed", "error");
      return;
    }
    get().runEdits(proposal.edits);
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
      eff.stmt.kind !== "meas"
    ) {
      get().showToast("Only walls, junctions, and measurements can be deleted", "info");
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

  openEditor(editor) {
    set({ editor });
  },

  closeEditor() {
    set({ editor: null });
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
      const t = editor.target;
      let edits: TextEdit[];
      switch (t.kind) {
        case "param":
          edits = proposeSetParam(
            project,
            branch,
            t.name,
            value,
            t.prov,
            t.prov === "measured" ? today() : undefined,
          );
          break;
        case "param-measure":
          edits = proposeSetParam(project, branch, t.name, value, "measured", today());
          break;
        case "measure-wall":
          edits = proposeMeasure(project, branch, { wall: t.wall }, value, today());
          break;
        case "measure-pair":
          edits = proposeMeasure(project, branch, { a: t.a, b: t.b }, value, today());
          break;
        case "meas-edit":
          edits = proposeEditMeas(project, branch, t.name, value, today());
          break;
      }
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
      const restored = loadProject(prev.files);
      set({
        project: restored,
        branch: prev.branch,
        past: past.slice(0, -1),
        future: [...future, { files: Object.fromEntries(project.files), branch }],
        selection: null,
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
      const restored = loadProject(next.files);
      set({
        project: restored,
        branch: next.branch,
        future: future.slice(0, -1),
        past: [...past, { files: Object.fromEntries(project.files), branch }],
        selection: null,
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
