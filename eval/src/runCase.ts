/**
 * Shared case I/O + scoring used by CLI and the eval UI server.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import {
  goldPathForImage,
  loadDimGold,
  scorePlanPair,
  writeReviewReport,
  type CaseMeta,
  type ScorePlanPairResult,
  type VisionStatus,
} from "./index";
import { deriveVisionStatus } from "./vision/status";
import { renderAblProjectToPng } from "../asbuilt/render";

export function casesRoot(cwd = process.cwd()): string {
  return join(cwd, "eval/cases");
}

export function isCaseDir(dir: string): boolean {
  return existsSync(join(dir, "reference.png"));
}

export function listCaseDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  if (isCaseDir(root)) return [root];
  if (!statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .map((e) => join(root, e))
    .filter((p) => statSync(p).isDirectory() && isCaseDir(p))
    .sort();
}

export function loadMeta(caseDir: string): CaseMeta {
  const p = join(caseDir, "meta.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as CaseMeta;
}

export function saveMeta(caseDir: string, meta: CaseMeta): void {
  writeFileSync(join(caseDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export async function ensureCandidate(caseDir: string, meta: CaseMeta): Promise<Buffer> {
  const candPath = join(caseDir, "candidate.png");
  if (existsSync(candPath) && !meta.asbuiltProject) {
    return readFileSync(candPath);
  }
  const projectRel =
    meta.asbuiltProject ?? (existsSync(join(caseDir, "project")) ? "project" : null);
  if (projectRel) {
    const projectDir = join(caseDir, projectRel);
    const { png, branch } = renderAblProjectToPng(projectDir, {
      branch: meta.branch,
      ppi: 5,
      showDims: true,
    });
    writeFileSync(candPath, png);
    void branch;
    return png;
  }
  if (existsSync(candPath)) return readFileSync(candPath);
  throw new Error(`No candidate.png and no asbuilt project in ${caseDir}`);
}

export interface CaseSummary {
  id: string;
  title: string;
  path: string;
  hasCandidate: boolean;
  hasProject: boolean;
  hasReferenceGold: boolean;
  hasCandidateGold: boolean;
  hasReview: boolean;
  lastScore?: {
    overall: number;
    layout: number;
    dims: number;
    spans: number;
    findings: number;
  };
  visionStatus?: VisionStatus;
}

export function summarizeCase(caseDir: string): CaseSummary {
  const id = basename(caseDir);
  const meta = loadMeta(caseDir);
  const goldRef = loadDimGold(goldPathForImage(caseDir, "reference"));
  const goldCand = loadDimGold(goldPathForImage(caseDir, "candidate"));
  const scorecardPath = join(caseDir, "reviews", "latest", "scorecard.json");
  let lastScore: CaseSummary["lastScore"];
  let visionStatus: VisionStatus | undefined;
  if (existsSync(scorecardPath)) {
    try {
      const sc = JSON.parse(readFileSync(scorecardPath, "utf8")) as {
        provisionalScore: { overall: number; layout: number; dims: number; spans: number };
        findings: unknown[];
        notes?: string[];
        visionStatus?: VisionStatus;
        referenceDimsUsed?: { verified?: boolean }[];
        candidateDimsUsed?: { verified?: boolean }[];
      };
      lastScore = {
        overall: sc.provisionalScore.overall,
        layout: sc.provisionalScore.layout,
        dims: sc.provisionalScore.dims,
        spans: sc.provisionalScore.spans,
        findings: sc.findings?.length ?? 0,
      };
      visionStatus =
        sc.visionStatus ??
        deriveVisionStatus({
          notes: sc.notes ?? [],
          referenceDimCount: sc.referenceDimsUsed?.length ?? 0,
          candidateDimCount: sc.candidateDimsUsed?.length ?? 0,
          usedReferenceGold:
            goldRef.length > 0 ||
            (sc.notes ?? []).some((n) => /verified reference gold/i.test(n)),
          usedCandidateGold:
            goldCand.length > 0 ||
            (sc.notes ?? []).some((n) => /verified candidate gold/i.test(n)),
        });
    } catch {
      /* ignore */
    }
  }
  return {
    id,
    title: meta.title ?? id,
    path: caseDir,
    hasCandidate: existsSync(join(caseDir, "candidate.png")),
    hasProject: existsSync(join(caseDir, "project")),
    hasReferenceGold: goldRef.length > 0,
    hasCandidateGold: goldCand.length > 0,
    hasReview: existsSync(join(caseDir, "reviews", "latest", "review.html")),
    lastScore,
    visionStatus,
  };
}

export async function runCase(caseDir: string): Promise<ScorePlanPairResult> {
  const id = basename(caseDir);
  const meta = loadMeta(caseDir);
  const reference = readFileSync(join(caseDir, "reference.png"));
  const candidate = await ensureCandidate(caseDir, meta);

  const referenceGold = loadDimGold(goldPathForImage(caseDir, "reference"));
  const candidateGold = loadDimGold(goldPathForImage(caseDir, "candidate"));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(caseDir, "reviews", runId);
  mkdirSync(outDir, { recursive: true });

  const result = await scorePlanPair({
    reference,
    candidate,
    referenceGold: referenceGold.length ? referenceGold : undefined,
    candidateGold: candidateGold.length ? candidateGold : undefined,
    tolerances: meta.tolerances,
    visionTiles: meta.visionTiles,
    artifactDir: outDir,
    cleanedCacheDir: join(caseDir, "cleaned"),
  });

  const latest = join(caseDir, "reviews", "latest");
  mkdirSync(join(caseDir, "reviews"), { recursive: true });
  try {
    cpSync(outDir, latest, { recursive: true });
  } catch {
    /* ignore */
  }

  writeReviewReport(outDir, result, { caseId: id });
  writeReviewReport(latest, result, { caseId: id });
  return result;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64) || `case_${Date.now()}`;
}

export function collectAblRelPaths(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...collectAblRelPaths(p, root));
    else if (p.endsWith(".abl")) out.push(relative(root, p));
  }
  return out;
}
