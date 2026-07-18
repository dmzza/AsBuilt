import { describe, expect, test } from "vitest";
import { DEMO_FILES } from "../../../src/demo";
import {
  collectMeasuredDimAnnotations,
  deriveAblEvalLayersFromFiles,
  pipelineToDimReadings,
  pipelineToStructureReading,
} from "../serialize";
import {
  ABL_PNG_SCALE,
  prepareAblFrame,
  pipelineToSvg,
} from "../render";
import { layerMap, loadProject, resolveAndSolve } from "../../../src/core";

const TINY_ABL = {
  "asbuilt.abl": `layer asbuilt

walltype std { thickness: 4 1/2" }

param w = 10'-0" [measured]
param d = 8'-0" [measured]

junction a ~(0", 0")
junction b ~(10'-0", 0")
junction c ~(10'-0", 8'-0")
junction dj ~(0", 8'-0")

wall south { from: a, to: b, type: std }
wall east { from: b, to: c, type: std }
wall north { from: c, to: dj, type: std }
wall west { from: dj, to: a, type: std }

axis south h
axis east v
axis north h
axis west v

length(south) = w
length(east) = d
length(north) = w
length(west) = d

meas m1 : dist(a, b) = 10'-0" [measured]
`,
};

describe("ABL serialize → structure/dims", () => {
  test("structure junctions and wallSpans match frame projection", () => {
    const project = loadProject(TINY_ABL);
    const pipeline = resolveAndSolve(layerMap(project), "asbuilt");
    const frame = prepareAblFrame(pipeline, { ppi: 5 });
    const structure = pipelineToStructureReading(pipeline, frame);

    expect(structure.junctions.length).toBe(4);
    expect(structure.wallSpans.length).toBe(4);

    const a = structure.junctions.find((j) => j.id === "a")!;
    expect(a.point.x).toBeCloseTo(frame.px(0), 5);
    expect(a.point.y).toBeCloseTo(frame.py(0), 5);
    expect(a.verified).toBe(true);
    expect(a.confidence).toBe(1);

    const south = structure.wallSpans.find((w) => w.id === "south")!;
    expect(south.aJunctionId).toBe("a");
    expect(south.bJunctionId).toBe("b");
    expect(south.a.x).toBeCloseTo(frame.px(0), 5);
    expect(south.b.x).toBeCloseTo(frame.px(120), 5);
  });

  test("dims are measured-grade only and use PNG-scale coords", () => {
    const project = loadProject(TINY_ABL);
    const pipeline = resolveAndSolve(layerMap(project), "asbuilt");
    const frame = prepareAblFrame(pipeline, { ppi: 5 });
    const anns = collectMeasuredDimAnnotations(pipeline);
    const dims = pipelineToDimReadings(pipeline, frame);

    expect(anns.some((a) => a.id === "m1")).toBe(true);
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.every((d) => d.verified === true)).toBe(true);
    expect(frame.scale).toBe(ABL_PNG_SCALE);

    const m1 = dims.find((d) => d.id === "m1")!;
    expect(m1.valueInches).toBeCloseTo(120, 5);
    expect(m1.span.a.x).toBeCloseTo(frame.px(0), 3);
    expect(m1.span.b.x).toBeCloseTo(frame.px(120), 3);
  });

  test("deriveAblEvalLayers produces PNG layers + JSON", () => {
    const layers = deriveAblEvalLayersFromFiles(TINY_ABL, { ppi: 5 });
    expect(layers.fullPng[0]).toBe(0x89);
    expect(layers.structurePng[0]).toBe(0x89);
    expect(layers.dimsPng[0]).toBe(0x89);
    expect(layers.structure.wallSpans.length).toBe(4);
    expect(layers.dims.length).toBeGreaterThan(0);

    const structureSvg = pipelineToSvg(layers.pipeline, {
      ppi: 5,
      layer: "structure",
    });
    expect(structureSvg).toContain("<svg");
    expect(structureSvg).not.toContain("10'-0"); // no length labels on structure layer
  });

  test("demo project serializes without throw", () => {
    const layers = deriveAblEvalLayersFromFiles(DEMO_FILES, {
      branch: "asbuilt",
      ppi: 5,
    });
    expect(layers.structure.junctions.length).toBeGreaterThan(4);
    expect(layers.dims.every((d) => d.verified)).toBe(true);
  });
});
