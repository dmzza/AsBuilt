import { create } from "zustand";
import {
  applyEdits,
  createConcept,
  layerMap,
  loadProject,
  proposeAddWall,
  proposeDelete,
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

export type Tool = "select" | "wall";

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
    set({ tool, pendingStart: null });
  },

  setWallType(wallType) {
    set({ wallType });
  },

  select(key) {
    set({ selection: key });
  },

  runEdits(edits) {
    const { project, branch, dirty } = get();
    if (project === null || edits.length === 0) return;
    try {
      const next = applyEdits(project, edits);
      const touched: Record<string, true> = { ...dirty };
      for (const e of edits) touched[e.file] = true;
      set({ project: next, dirty: touched, ...compute(next, branch) });
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
      get().showToast("Move could not be applied cleanly; check diagnostics", "info");
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
    if (eff.stmt.kind !== "wall" && eff.stmt.kind !== "junction") {
      get().showToast("Only walls and junctions can be deleted here", "info");
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
      const today = new Date().toISOString().slice(0, 10);
      const edits = proposeSetParam(
        project,
        branch,
        name,
        value,
        prov,
        prov === "measured" ? today : undefined,
      );
      get().runEdits(edits);
    } catch (e) {
      get().showToast(`Set failed: ${(e as Error).message}`, "error");
    }
  },

  showToast(message, kind = "info") {
    set({ toast: { message, kind, at: Date.now() } });
  },
}));
