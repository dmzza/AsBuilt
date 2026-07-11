/**
 * Plan fidelity evaluator CLI.
 *
 *   npm run eval -- eval/cases/demo_dining
 *   npm run eval -- eval/cases
 */
import { resolve, basename } from "node:path";
import { listCaseDirs, runCase, casesRoot, isCaseDir } from "../eval/src/runCase";
import { existsSync, statSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.length === 0) {
  console.error("usage: npm run eval -- <case-dir-or-suite>");
  console.error("  or:  npm run eval:ui");
  process.exit(2);
}

const root = resolve(args[0]!);
let cases: string[] = [];
if (isCaseDir(root)) cases = [root];
else if (existsSync(root) && statSync(root).isDirectory()) cases = listCaseDirs(root);
else {
  console.error(`no cases with reference.png under ${root}`);
  process.exit(2);
}

if (cases.length === 0) {
  console.error(`no cases with reference.png under ${root}`);
  console.error(`(default suite lives at ${casesRoot()})`);
  process.exit(2);
}

let worst = 1;
for (const c of cases) {
  console.log(`\n── case: ${basename(c)}`);
  const r = await runCase(c);
  const s = r.provisionalScore;
  console.log(
    `  score  overall=${(s.overall * 100).toFixed(1)}%  layout=${(s.layout * 100).toFixed(1)}%  dims=${(s.dims * 100).toFixed(1)}%  spans=${(s.spans * 100).toFixed(1)}%`,
  );
  console.log(`  findings: ${r.findings.length}`);
  for (const n of r.notes) console.log(`  note  ${n}`);
  worst = Math.min(worst, s.overall);
}

console.log(`\nDone. ${cases.length} case(s). Worst overall=${(worst * 100).toFixed(1)}%`);
