import { describe, expect, test } from "vitest";
import { layerMap, loadProject, printLayerFile, resolveAndSolve } from "../core";

// examples/<project>/**/*.abl, keyed by path relative to the project dir
const raw = import.meta.glob("../../examples/*/**/*.abl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const projects = new Map<string, Record<string, string>>();
for (const [path, text] of Object.entries(raw)) {
  const m = /examples\/([^/]+)\/(.+)$/.exec(path)!;
  const files = projects.get(m[1]!) ?? {};
  files[m[2]!] = text;
  projects.set(m[1]!, files);
}

describe("example projects stay valid", () => {
  expect(projects.size).toBeGreaterThan(0);

  for (const [name, files] of projects) {
    test(`${name}: every branch resolves, solves, and is conflict-free`, () => {
      const project = loadProject(files);
      for (const branch of project.layers.keys()) {
        const p = resolveAndSolve(layerMap(project), branch);
        expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(p.solution.converged).toBe(true);
        expect(p.solution.contradictions).toEqual([]);
      }
    });

    test(`${name}: files are in canonical form (re-save is byte-identical)`, () => {
      const project = loadProject(files);
      for (const [, layer] of project.layers) {
        expect(printLayerFile(layer.parsed)).toBe(project.files.get(layer.file));
      }
    });
  }
});
