/**
 * Validate .abl project files: parse, resolve every branch, solve, and report
 * diagnostics, contradictions, and the assumption audit.
 *
 *   npx vite-node scripts/check.ts <file-or-directory> [...more]
 *
 * Exit code 1 on parse failures or resolve errors; contradictions are
 * reported but do not fail the check (they are user decisions, not defects).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allParams,
  formatLength,
  layerMap,
  loadProject,
  resolveAndSolve,
  s64FromInches,
} from "../src/core";

function collectAblFiles(path: string, out: Map<string, string>): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry.startsWith(".")) continue;
      collectAblFiles(join(path, entry), out);
    }
  } else if (path.endsWith(".abl")) {
    out.set(relative(process.cwd(), path), readFileSync(path, "utf8"));
  }
}

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.length === 0) {
  console.error("usage: npx vite-node scripts/check.ts <file-or-directory> [...more]");
  process.exit(2);
}

const files = new Map<string, string>();
for (const arg of args) collectAblFiles(arg, files);
if (files.size === 0) {
  console.error("no .abl files found");
  process.exit(2);
}
console.log(`checking ${files.size} file(s): ${[...files.keys()].join(", ")}\n`);

let failed = false;

let project;
try {
  project = loadProject(Object.fromEntries(files));
} catch (e) {
  console.error(`PARSE ERROR: ${(e as Error).message}`);
  process.exit(1);
}

for (const [branch] of project.layers) {
  console.log(`── branch: ${branch}`);
  const p = resolveAndSolve(layerMap(project), branch);

  const errors = p.diagnostics.filter((d) => d.severity === "error");
  const warnings = p.diagnostics.filter((d) => d.severity === "warning");
  for (const d of errors) {
    failed = true;
    console.log(`   ERROR   ${d.message}`);
  }
  for (const d of warnings) console.log(`   warn    ${d.message}`);

  if (!p.solution.converged) {
    failed = true;
    console.log("   ERROR   solver did not converge");
  }

  for (const c of p.solution.contradictions) {
    const worst = Math.max(...c.violated.map((v) => v.residualInches));
    console.log(
      `   CONFLICT measurements disagree (off by ${formatLength(s64FromInches(worst))}); ` +
        `suspects: ${c.suspects.join(", ")}`,
    );
  }

  const params = allParams(p);
  const audit = params.filter((v) => v.prov === "approximated");
  const counts = { junctions: 0, walls: 0, openings: 0, fixtures: 0, meas: 0, levels: 0 };
  for (const [, eff] of p.resolved.effective) {
    if (eff.stmt.kind === "junction") counts.junctions++;
    else if (eff.stmt.kind === "wall") counts.walls++;
    else if (eff.stmt.kind === "opening") counts.openings++;
    else if (eff.stmt.kind === "fixture") counts.fixtures++;
    else if (eff.stmt.kind === "meas") counts.meas++;
    else if (eff.stmt.kind === "level") counts.levels++;
  }
  const levelsNote = counts.levels > 0 ? `, ${counts.levels + 1} levels` : "";
  console.log(
    `   ok      ${counts.walls} walls, ${counts.junctions} junctions, ` +
      `${counts.openings} openings, ${counts.fixtures} fixtures, ` +
      `${counts.meas} measurements${levelsNote}`,
  );
  console.log(
    `   audit   ${audit.length} approximated (to measure): ` +
      `${audit.map((v) => v.name).join(", ") || "none"}`,
  );
  for (const v of params) {
    const drift = Math.abs(v.solvedInches - v.authoredInches);
    if (drift > 1 / 32) {
      console.log(
        `   drift   ${v.name}: authored ${formatLength(s64FromInches(v.authoredInches))}, ` +
          `solves to ${formatLength(s64FromInches(Math.round(v.solvedInches * 64) / 64))}`,
      );
    }
  }
  console.log("");
}

process.exit(failed ? 1 : 0);
