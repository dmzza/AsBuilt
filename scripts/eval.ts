/**
 * Plan fidelity evaluator CLI.
 *
 *   npm run eval -- eval/cases/demo_dining
 *   npm run eval -- eval/cases
 *
 * Case layout:
 *   reference.png
 *   candidate.png          (optional if meta.asbuiltProject set)
 *   project/               (optional .abl tree)
 *   gold/reference.dims.json
 *   gold/candidate.dims.json
 *   meta.json
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
import { join, resolve, basename } from "node:path";
import {
  goldPathForImage,
  loadDimGold,
  scorePlanPair,
  writeReviewReport,
  type CaseMeta,
  type ScorePlanPairResult,
} from "../eval/src/index";
import { renderAblProjectToPng } from "../eval/asbuilt/render";

function isCaseDir(dir: string): boolean {
  return existsSync(join(dir, "reference.png")) || existsSync(join(dir, "meta.json"));
}

function listCases(root: string): string[] {
  if (isCaseDir(root) && existsSync(join(root, "reference.png"))) return [root];
  if (!statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .map((e) => join(root, e))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "reference.png")));
}

function loadMeta(caseDir: string): CaseMeta {
  const p = join(caseDir, "meta.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as CaseMeta;
}

async function ensureCandidate(caseDir: string, meta: CaseMeta): Promise<Buffer> {
  const candPath = join(caseDir, "candidate.png");
  if (existsSync(candPath) && !meta.asbuiltProject) {
    return readFileSync(candPath);
  }
  const projectRel = meta.asbuiltProject ?? (existsSync(join(caseDir, "project")) ? "project" : null);
  if (projectRel) {
    const projectDir = join(caseDir, projectRel);
    console.log(`  rendering AsBuilt project ${projectRel}…`);
    const { png, branch } = renderAblProjectToPng(projectDir, {
      branch: meta.branch,
      ppi: 5,
      showDims: true,
    });
    writeFileSync(candPath, png);
    console.log(`  wrote candidate.png (branch ${branch})`);
    return png;
  }
  if (existsSync(candPath)) return readFileSync(candPath);
  throw new Error(`No candidate.png and no asbuilt project in ${caseDir}`);
}

async function runCase(caseDir: string): Promise<ScorePlanPairResult> {
  const id = basename(caseDir);
  console.log(`\n── case: ${id}`);
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
    artifactDir: outDir,
  });

  // Also copy latest pointer
  const latest = join(caseDir, "reviews", "latest");
  mkdirSync(join(caseDir, "reviews"), { recursive: true });
  try {
    cpSync(outDir, latest, { recursive: true });
  } catch {
    // ignore
  }

  const report = writeReviewReport(outDir, result, { caseId: id });
  writeReviewReport(latest, result, { caseId: id });

  const s = result.provisionalScore;
  console.log(
    `  score  overall=${(s.overall * 100).toFixed(1)}%  layout=${(s.layout * 100).toFixed(1)}%  dims=${(s.dims * 100).toFixed(1)}%  spans=${(s.spans * 100).toFixed(1)}%`,
  );
  console.log(`  findings: ${result.findings.length}`);
  console.log(`  ref dims: ${result.referenceDimsUsed.length} (gold=${referenceGold.length})`);
  console.log(`  cand dims: ${result.candidateDimsUsed.length} (gold=${candidateGold.length})`);
  for (const n of result.notes) console.log(`  note  ${n}`);
  console.log(`  report ${report}`);
  console.log(`  open   npm run eval:review -- ${caseDir}`);

  return result;
}

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.length === 0) {
  console.error("usage: npm run eval -- <case-dir-or-suite>");
  process.exit(2);
}

const root = resolve(args[0]!);
const cases = listCases(root);
if (cases.length === 0) {
  console.error(`no cases with reference.png under ${root}`);
  process.exit(2);
}

let worst = 1;
for (const c of cases) {
  const r = await runCase(c);
  worst = Math.min(worst, r.provisionalScore.overall);
}

console.log(`\nDone. ${cases.length} case(s). Worst overall=${(worst * 100).toFixed(1)}%`);
