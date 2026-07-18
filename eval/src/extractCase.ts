/**
 * Single-reference authoring prep: Nano Banana redraw + Gemini structure/dims extract.
 * No candidate required — writes cleaned/ + extract/ artifacts for ABL authoring.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { extractDimensions } from "./dims/extract";
import { formatInches } from "./image";
import { drawDimsOverlay, drawStructureOverlay } from "./overlay";
import { writeExtractReport } from "./report";
import {
  casesRoot,
  ensureReference,
  isCaseDir,
  loadMeta,
  saveMeta,
  slugify,
} from "./runCase";
import { extractStructure } from "./structure/extract";
import type {
  CaseMeta,
  DimReading,
  StructureReading,
  VisionStatus,
} from "./types";
import { imageMeta } from "./vision/prepare";
import { deriveVisionStatus } from "./vision/status";

export interface ExtractCaseOpts {
  /** Case directory or path to a reference PNG/JPEG. */
  input: string;
  /** Override case dir when input is a bare image. */
  outDir?: string;
  /** When false, dim extract is one-shot full-page only. Default true. */
  visionTiles?: boolean;
  cwd?: string;
}

export interface ExtractCaseResult {
  caseDir: string;
  caseId: string;
  createdCase: boolean;
  structure: StructureReading;
  dimensions: DimReading[];
  structureCleaned: "ok" | "cached" | "fallback" | "skipped";
  dimsCleaned: "ok" | "cached" | "fallback" | "skipped";
  notes: string[];
  visionStatus: VisionStatus;
  artifacts: {
    referencePng: string;
    structureRefPng?: string;
    dimsRefPng?: string;
    structureJson: string;
    dimsJson: string;
    summaryMd: string;
    reviewHtml: string;
    structureOverlayPng?: string;
    dimsOverlayPng?: string;
  };
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase());
}

/**
 * Resolve input to a case directory with reference.png.
 * Bare images are copied into eval/cases/<slug>/ (or --out).
 */
export function resolveExtractCaseDir(
  input: string,
  opts?: { outDir?: string; cwd?: string },
): { caseDir: string; createdCase: boolean } {
  const cwd = opts?.cwd ?? process.cwd();
  const root = resolve(cwd, input);

  if (isCaseDir(root)) {
    return { caseDir: root, createdCase: false };
  }

  if (existsSync(root) && isImagePath(root)) {
    const caseDir = opts?.outDir
      ? resolve(opts.outDir)
      : join(casesRoot(cwd), slugify(basename(root)));
    const existed = isCaseDir(caseDir);
    mkdirSync(caseDir, { recursive: true });
    const dest = join(caseDir, "reference.png");
    if (resolve(root) !== resolve(dest)) {
      cpSync(root, dest);
    }
    const meta = loadMeta(caseDir);
    if (!meta.title) {
      saveMeta(caseDir, {
        ...meta,
        title: slugify(basename(root)).replace(/_/g, " "),
      });
    }
    return { caseDir, createdCase: !existed };
  }

  throw new Error(
    `Expected a case directory with reference.png, reference_project/, or an image file; got: ${input}`,
  );
}


function writeSummaryMd(opts: {
  caseId: string;
  structure: StructureReading;
  dimensions: DimReading[];
  notes: string[];
  structureCleaned: string;
  dimsCleaned: string;
}): string {
  const dimLines = opts.dimensions
    .map((d) => {
      const text = d.valueText ?? formatInches(d.valueInches);
      return `- \`${d.id}\`: **${text}** (${d.valueInches.toFixed(2)}") conf=${(d.confidence ?? 0).toFixed(2)}`;
    })
    .join("\n");

  return `# Extract summary — ${opts.caseId}

Authoring prep for a single reference sketch (no candidate).

## Counts

| Layer | Count | Clean status |
| --- | ---: | --- |
| Junctions | ${opts.structure.junctions.length} | ${opts.structureCleaned} |
| Wall spans | ${opts.structure.wallSpans.length} | ${opts.structureCleaned} |
| Dimensions | ${opts.dimensions.length} | ${opts.dimsCleaned} |

## How to use

1. Open \`cleaned/structure_ref.png\` for wall topology (ignore dim clutter).
2. Open \`cleaned/dims_ref.png\` for measurement annotations only.
3. Read \`extract/structure_ref.json\` → map junctions → ABL \`junction\`, wallSpans → \`wall\`.
4. Read \`extract/dims_ref.json\` → map each reading → \`[measured]\` params / \`meas\` (check handwriting; ask if ambiguous).
5. Author \`.abl\`, render a candidate (or place \`candidate.png\` / \`project/\`), then score:
   \`\`\`
   npm run eval -- eval/cases/${opts.caseId}
   \`\`\`

## Dimensions

${dimLines || "_None extracted._"}

## Notes

${opts.notes.map((n) => `- ${n}`).join("\n") || "_None._"}
`;
}

/**
 * Run structure + dims redraw/extract for one reference image.
 */
export async function extractReferenceCase(
  opts: ExtractCaseOpts,
): Promise<ExtractCaseResult> {
  const { caseDir, createdCase } = resolveExtractCaseDir(opts.input, {
    outDir: opts.outDir,
    cwd: opts.cwd,
  });
  const caseId = basename(caseDir);
  const meta: CaseMeta = loadMeta(caseDir);
  const refPath = join(caseDir, "reference.png");
  
  // Render reference.png from reference_project if needed
  if (!existsSync(refPath)) {
    const projectRel =
      meta.referenceProject ??
      (existsSync(join(caseDir, "reference_project")) ? "reference_project" : null);
    if (projectRel) {
      try {
        ensureReference(caseDir, meta);
      } catch (e) {
        throw new Error(
          `Missing reference.png and failed to render from ${projectRel}: ${(e as Error).message}`,
        );
      }
    } else {
      throw new Error(`Missing reference.png in ${caseDir}`);
    }
  }

  const reference = readFileSync(refPath);
  const meta: CaseMeta = loadMeta(caseDir);
  const tiles = opts.visionTiles ?? meta.visionTiles !== false;
  const cleanedDir = join(caseDir, "cleaned");
  const extractDir = join(caseDir, "extract");
  const reviewDir = join(caseDir, "reviews", "extract");
  mkdirSync(cleanedDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });

  const notes: string[] = [];
  if (!tiles) notes.push("Vision dim extract: one-shot full-page only (tiles disabled)");

  try {
    const metaImg = await imageMeta(reference);
    notes.push(`Reference size ${metaImg.width}×${metaImg.height}`);
  } catch {
    /* ignore */
  }

  const structureCache = join(cleanedDir, "structure_ref.png");
  const dimsCache = join(cleanedDir, "dims_ref.png");

  const sx = await extractStructure(reference, { cleanedCachePath: structureCache });
  notes.push(...sx.notes.map((n) => `structure: ${n}`));

  const dx = await extractDimensions(reference, {
    tiles,
    cleanedCachePath: dimsCache,
  });
  notes.push(...dx.notes.map((n) => `dims: ${n}`));

  const structureJsonPath = join(extractDir, "structure_ref.json");
  const dimsJsonPath = join(extractDir, "dims_ref.json");
  writeFileSync(
    structureJsonPath,
    JSON.stringify(
      {
        image: "reference.png",
        cleaned: sx.cleanedPng ? "cleaned/structure_ref.png" : null,
        cleanedStatus: sx.cleanedStatus,
        junctions: sx.structure.junctions,
        wallSpans: sx.structure.wallSpans,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    dimsJsonPath,
    JSON.stringify(
      {
        image: "reference.png",
        cleaned: dx.cleanedPng ? "cleaned/dims_ref.png" : null,
        cleanedStatus: dx.cleanedStatus,
        dimensions: dx.readings,
      },
      null,
      2,
    ) + "\n",
  );

  const summaryPath = join(extractDir, "summary.md");
  writeFileSync(
    summaryPath,
    writeSummaryMd({
      caseId,
      structure: sx.structure,
      dimensions: dx.readings,
      notes,
      structureCleaned: sx.cleanedStatus,
      dimsCleaned: dx.cleanedStatus,
    }),
  );

  writeFileSync(join(reviewDir, "reference.png"), reference);
  if (sx.cleanedPng) {
    writeFileSync(join(reviewDir, "structure_ref.png"), sx.cleanedPng);
  }
  if (dx.cleanedPng) {
    writeFileSync(join(reviewDir, "dims_ref.png"), dx.cleanedPng);
  }

  let structureOverlayPng: string | undefined;
  let dimsOverlayPng: string | undefined;
  const structureBase = sx.cleanedPng ?? reference;
  const dimsBase = dx.cleanedPng ?? reference;

  try {
    const sOverlay = await drawStructureOverlay(structureBase, sx.structure, {
      title: "Structure detections",
    });
    writeFileSync(join(reviewDir, "structure_overlay.png"), sOverlay);
    structureOverlayPng = "structure_overlay.png";
  } catch (e) {
    notes.push(`Structure overlay failed: ${(e as Error).message}`);
  }

  try {
    const dOverlay = await drawDimsOverlay(dimsBase, dx.readings, [], {
      title: "Dimension detections",
    });
    writeFileSync(join(reviewDir, "dims_overlay.png"), dOverlay);
    dimsOverlayPng = "dims_overlay.png";
  } catch (e) {
    notes.push(`Dims overlay failed: ${(e as Error).message}`);
  }

  const visionStatus = deriveVisionStatus({
    notes,
    referenceDimCount: dx.readings.length,
    candidateDimCount: 0,
    usedReferenceGold: false,
    usedCandidateGold: false,
  });

  const metaOut: CaseMeta = {
    ...meta,
    title: meta.title ?? caseId.replace(/_/g, " "),
  };
  if (tiles) {
    delete metaOut.visionTiles;
  } else {
    metaOut.visionTiles = false;
  }
  saveMeta(caseDir, metaOut);

  const reviewHtml = writeExtractReport(reviewDir, {
    caseId,
    notes,
    visionStatus,
    structure: sx.structure,
    dimensions: dx.readings,
    structureCleaned: sx.cleanedStatus,
    dimsCleaned: dx.cleanedStatus,
    overlays: {
      referencePng: "reference.png",
      structureRefPng: sx.cleanedPng ? "structure_ref.png" : undefined,
      dimsRefPng: dx.cleanedPng ? "dims_ref.png" : undefined,
      structureOverlayPng,
      dimsOverlayPng,
    },
  });

  writeFileSync(
    join(extractDir, "manifest.json"),
    JSON.stringify(
      {
        caseId,
        createdAt: new Date().toISOString(),
        structureCleaned: sx.cleanedStatus,
        dimsCleaned: dx.cleanedStatus,
        junctionCount: sx.structure.junctions.length,
        wallSpanCount: sx.structure.wallSpans.length,
        dimCount: dx.readings.length,
        visionStatus,
        notes,
      },
      null,
      2,
    ) + "\n",
  );

  // Keep summary in sync after late notes (overlays).
  writeFileSync(
    summaryPath,
    writeSummaryMd({
      caseId,
      structure: sx.structure,
      dimensions: dx.readings,
      notes,
      structureCleaned: sx.cleanedStatus,
      dimsCleaned: dx.cleanedStatus,
    }),
  );

  return {
    caseDir,
    caseId,
    createdCase,
    structure: sx.structure,
    dimensions: dx.readings,
    structureCleaned: sx.cleanedStatus,
    dimsCleaned: dx.cleanedStatus,
    notes,
    visionStatus,
    artifacts: {
      referencePng: refPath,
      structureRefPng: sx.cleanedPng ? structureCache : undefined,
      dimsRefPng: dx.cleanedPng ? dimsCache : undefined,
      structureJson: structureJsonPath,
      dimsJson: dimsJsonPath,
      summaryMd: summaryPath,
      reviewHtml,
      structureOverlayPng: structureOverlayPng
        ? join(reviewDir, structureOverlayPng)
        : undefined,
      dimsOverlayPng: dimsOverlayPng ? join(reviewDir, dimsOverlayPng) : undefined,
    },
  };
}
