/**
 * Deterministic ABL → eval StructureReading / DimReading (image pixel space).
 * Shares projection with eval/asbuilt/render.ts — no AI.
 */
import {
  allWallGrades,
  faceMeasureEndpoints,
  formatLength,
  junctionPos,
  layerMap,
  loadProject,
  resolveAndSolve,
  s64FromInches,
  s64ToInches,
  thicknessValue,
  type Pipeline,
} from "../../src/core";
import type {
  DimGold,
  DimReading,
  Junction,
  JunctionKind,
  StructureReading,
  WallSpan,
} from "../src/types";
import {
  ABL_PNG_SCALE,
  allWalls,
  loadAblProjectDir,
  placeDimAnnotation,
  pipelineToSvg,
  prepareAblFrame,
  svgToPng,
  type AblFrame,
  type DimAnnotation,
  type RenderOptions,
} from "./render";

function junctionKind(
  degree: number,
): JunctionKind {
  if (degree <= 1) return "end";
  if (degree === 2) return "corner";
  if (degree === 3) return "t";
  if (degree >= 4) return "cross";
  return "unknown";
}

export function pipelineToStructureReading(
  p: Pipeline,
  frame: AblFrame,
): StructureReading {
  const walls = allWalls(p);
  const degree = new Map<string, number>();
  for (const w of walls) {
    degree.set(w.from, (degree.get(w.from) ?? 0) + 1);
    degree.set(w.to, (degree.get(w.to) ?? 0) + 1);
  }

  const junctions: Junction[] = [];
  const seen = new Set<string>();
  for (const w of walls) {
    for (const name of [w.from, w.to]) {
      if (seen.has(name)) continue;
      seen.add(name);
      const j = junctionPos(p.solution, name);
      if (!j) continue;
      junctions.push({
        id: name,
        point: { x: frame.px(j.x), y: frame.py(j.y) },
        kind: junctionKind(degree.get(name) ?? 0),
        confidence: 1,
        verified: true,
      });
    }
  }

  const wallSpans: WallSpan[] = walls.map((w) => ({
    id: w.name,
    a: { x: frame.px(w.a.x), y: frame.py(w.a.y) },
    b: { x: frame.px(w.b.x), y: frame.py(w.b.y) },
    aJunctionId: w.from,
    bJunctionId: w.to,
    confidence: 1,
    verified: true,
  }));

  return { junctions, wallSpans };
}

/** Collect measured-grade dim annotations in world inches (for SVG + JSON). */
export function collectMeasuredDimAnnotations(p: Pipeline): DimAnnotation[] {
  const out: DimAnnotation[] = [];
  const grades = allWallGrades(p);
  const seenWalls = new Set<string>();

  for (const [key, eff] of p.resolved.effective) {
    if (eff.stmt.kind !== "meas") continue;
    const stmt = eff.stmt;
    const ends = faceMeasureEndpoints(
      p.resolved,
      (name) => junctionPos(p.solution, name),
      (wallType) => thicknessValue(p.solution, wallType) ?? 0,
      stmt.a,
      stmt.b,
      stmt.ref,
    );
    if (!ends) continue;
    const valueInches = s64ToInches(stmt.value);
    out.push({
      id: key,
      a: ends.a,
      b: ends.b,
      valueInches,
      valueText: formatLength(stmt.value),
    });
  }

  for (const w of allWalls(p)) {
    const g = grades.get(w.name);
    if (g?.grade !== "measured") continue;
    if (seenWalls.has(w.name)) continue;
    // Skip walls already covered by a meas on the same endpoints (approx).
    const covered = out.some((ann) => {
      const d1 =
        Math.hypot(ann.a.x - w.a.x, ann.a.y - w.a.y) +
        Math.hypot(ann.b.x - w.b.x, ann.b.y - w.b.y);
      const d2 =
        Math.hypot(ann.a.x - w.b.x, ann.a.y - w.b.y) +
        Math.hypot(ann.b.x - w.a.x, ann.b.y - w.a.y);
      return Math.min(d1, d2) < 0.5;
    });
    if (covered) continue;
    seenWalls.add(w.name);
    const rounded = Math.round(w.lengthInches * 16) / 16;
    out.push({
      id: `wall:${w.name}`,
      a: w.a,
      b: w.b,
      valueInches: w.lengthInches,
      valueText: formatLength(s64FromInches(rounded)),
    });
  }

  return out;
}

export function pipelineToDimReadings(
  p: Pipeline,
  frame: AblFrame,
): DimGold[] {
  const anns = collectMeasuredDimAnnotations(p);
  const scale = frame.scale;
  return anns.map((ann) => {
    const place = placeDimAnnotation(frame, ann);
    const reading: DimGold = {
      id: ann.id,
      valueInches: ann.valueInches,
      valueText: ann.valueText,
      labelBBox: {
        x: place.labelSvg.x * scale,
        y: place.labelSvg.y * scale,
        w: place.labelSvg.w * scale,
        h: place.labelSvg.h * scale,
      },
      span: {
        a: { x: place.spanSvg.a.x * scale, y: place.spanSvg.a.y * scale },
        b: { x: place.spanSvg.b.x * scale, y: place.spanSvg.b.y * scale },
      },
      dimGraphics: {
        dimLine: {
          a: { x: place.dimLine.a.x * scale, y: place.dimLine.a.y * scale },
          b: { x: place.dimLine.b.x * scale, y: place.dimLine.b.y * scale },
        },
        extensionA: {
          a: { x: place.extensionA.a.x * scale, y: place.extensionA.a.y * scale },
          b: { x: place.extensionA.b.x * scale, y: place.extensionA.b.y * scale },
        },
        extensionB: {
          a: { x: place.extensionB.a.x * scale, y: place.extensionB.a.y * scale },
          b: { x: place.extensionB.b.x * scale, y: place.extensionB.b.y * scale },
        },
      },
      confidence: 1,
      verified: true,
    };
    return reading;
  });
}

export interface AblEvalLayers {
  pipeline: Pipeline;
  branch: string;
  frame: AblFrame;
  fullPng: Buffer;
  structurePng: Buffer;
  dimsPng: Buffer;
  structure: StructureReading;
  dims: DimGold[];
  /** Also exposed as DimReading[] for callers that don't need verified. */
  dimReadings: DimReading[];
}

export function deriveAblEvalLayers(
  projectDir: string,
  opts: RenderOptions = {},
): AblEvalLayers {
  const files = loadAblProjectDir(projectDir);
  return deriveAblEvalLayersFromFiles(files, opts);
}

export function deriveAblEvalLayersFromFiles(
  files: Record<string, string>,
  opts: RenderOptions = {},
): AblEvalLayers {
  const project = loadProject(files);
  const branch = opts.branch ?? [...project.layers.keys()][0];
  if (!branch) throw new Error("no layers in project");
  const pipeline = resolveAndSolve(layerMap(project), branch);
  const errors = pipeline.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(`resolve errors: ${errors.map((e) => e.message).join("; ")}`);
  }

  const renderOpts: RenderOptions = { ppi: 5, showDims: true, ...opts };
  const frame = prepareAblFrame(pipeline, renderOpts);
  const annotations = collectMeasuredDimAnnotations(pipeline);

  const fullSvg = pipelineToSvg(pipeline, { ...renderOpts, layer: "full" });
  const structureSvg = pipelineToSvg(pipeline, { ...renderOpts, layer: "structure" });
  const dimsSvg = pipelineToSvg(
    pipeline,
    { ...renderOpts, layer: "dims" },
    annotations,
  );

  const dims = pipelineToDimReadings(pipeline, frame);
  return {
    pipeline,
    branch,
    frame,
    fullPng: svgToPng(fullSvg, ABL_PNG_SCALE),
    structurePng: svgToPng(structureSvg, ABL_PNG_SCALE),
    dimsPng: svgToPng(dimsSvg, ABL_PNG_SCALE),
    structure: pipelineToStructureReading(pipeline, frame),
    dims,
    dimReadings: dims,
  };
}
