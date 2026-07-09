import { describe, expect, test } from "vitest";
import { layerMap, loadProject, resolveAndSolve } from "../core";
import { parseLayerFile } from "../core/parser";
import { printLayerFile } from "../core/printer";
import { DEMO_FILES } from "../demo";

describe("demo project", () => {
  test("every file is canonical (re-save byte-identical)", () => {
    for (const [file, text] of Object.entries(DEMO_FILES)) {
      expect(printLayerFile(parseLayerFile(file, text))).toBe(text);
    }
  });

  test("both branches resolve and solve without errors", () => {
    const project = loadProject(DEMO_FILES);
    for (const branch of ["asbuilt", "galley"]) {
      const p = resolveAndSolve(layerMap(project), branch);
      expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(p.solution.converged).toBe(true);
      expect(p.solution.contradictions).toEqual([]);
    }
  });
});
