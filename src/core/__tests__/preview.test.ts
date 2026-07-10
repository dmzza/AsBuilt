import { describe, expect, test } from "vitest";
import {
  applyEdits,
  layerMap,
  loadProject,
  previewDiff,
  proposeDelete,
  proposeSetFixture,
  proposeSetParam,
  resolveAndSolve,
  type Pipeline,
  type Project,
} from "../index";

const BASE = `layer asbuilt

walltype int_2x4 { thickness: 4 1/2" }

param k.depth = 10'-0" [measured 2026-07-01]
param k.width = 11'-6" [approximated]

room k : rect(k.width, k.depth) { at: ~(0", 0"), walls: int_2x4 }

meas m1 : dist(k.sw, k.ne) = 15'-0" [measured 2026-07-09]

fixture fridge { kind: fridge, at: ~(3'-0", 3'-0"), size: 3'-0" x 2'-6" }
`;

function load(text = BASE): { project: Project; pipeline: Pipeline } {
  const project = loadProject({ "asbuilt.abl": text });
  return { project, pipeline: resolveAndSolve(layerMap(project), "asbuilt") };
}

function scratch(project: Project, edits: Parameters<typeof applyEdits>[1]): Pipeline {
  return resolveAndSolve(layerMap(applyEdits(project, edits)), "asbuilt");
}

describe("previewDiff", () => {
  test("identical pipelines diff empty", () => {
    const { pipeline } = load();
    expect(previewDiff(pipeline, pipeline)).toEqual({
      walls: [],
      openings: [],
      fixtures: [],
      removed: [],
    });
  });

  test("widening a room moves the walls hanging off it, not the anchored one", () => {
    // without the diagonal: a measured diag would pin the soft width in place
    const { project, pipeline } = load(BASE.replace(/meas m1 .*\n/, ""));
    const next = scratch(
      project,
      proposeSetParam(project, "asbuilt", "k.width", 15 * 12 * 64, "approximated"),
    );
    const diff = previewDiff(pipeline, next);
    // anchored at k.sw: the east wall and the spans reaching it all move
    expect(diff.walls).toContain("k.east");
    expect(diff.walls).not.toContain("k.west");
    expect(diff.removed).toEqual([]);
  });

  test("deleting a measurement marks it removed (and geometry relaxes)", () => {
    const { project, pipeline } = load();
    const next = scratch(project, proposeDelete(project, "asbuilt", "m1"));
    const diff = previewDiff(pipeline, next);
    expect(diff.removed).toContain("m1");
    expect(diff.removed).not.toContain("k.east");
  });

  test("moving a fixture shows up as a fixture change only", () => {
    const { project, pipeline } = load();
    const next = scratch(
      project,
      proposeSetFixture(project, "asbuilt", "fridge", {
        at: { x: 6 * 12 * 64, y: 3 * 12 * 64 },
      }),
    );
    const diff = previewDiff(pipeline, next);
    expect(diff.fixtures).toEqual(["fridge"]);
    expect(diff.walls).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("deleting a fixture marks only the fixture removed", () => {
    const { project, pipeline } = load();
    const next = scratch(project, proposeDelete(project, "asbuilt", "fridge"));
    const diff = previewDiff(pipeline, next);
    expect(diff.removed).toEqual(["fridge"]);
  });
});
