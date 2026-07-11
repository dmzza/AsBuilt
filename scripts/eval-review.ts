/**
 * Serve the latest review UI over HTTP so Verify → gold can POST into the case.
 *
 *   npm run eval:review -- eval/cases/demo_dining
 *   npm run eval:review -- eval/cases/demo_dining --import-gold path/to/gold.dims.json
 *   npm run eval:review -- eval/cases/demo_dining --port 8787
 */
import { createServer } from "node:http";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import { execSync } from "node:child_process";
import { goldPathForImage, saveDimGold, type DimGold } from "../eval/src/index";

const args = process.argv.slice(2).filter((a) => a !== "--");
const caseDir = resolve(args[0] ?? "");
if (!caseDir || !existsSync(caseDir)) {
  console.error("usage: npm run eval:review -- <case-dir> [--import-gold file.json] [--port N]");
  process.exit(2);
}

const importIdx = args.indexOf("--import-gold");
if (importIdx >= 0) {
  const file = args[importIdx + 1];
  if (!file || !existsSync(file)) {
    console.error("--import-gold requires a JSON file path");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    reference?: DimGold[];
    candidate?: DimGold[];
    dimensions?: DimGold[];
  };
  mkdirSync(join(caseDir, "gold"), { recursive: true });
  if (raw.reference?.length) {
    saveDimGold(
      goldPathForImage(caseDir, "reference"),
      raw.reference.map((d) => ({ ...d, verified: true as const })),
    );
    console.log(`wrote ${goldPathForImage(caseDir, "reference")}`);
  }
  if (raw.candidate?.length) {
    saveDimGold(
      goldPathForImage(caseDir, "candidate"),
      raw.candidate.map((d) => ({ ...d, verified: true as const })),
    );
    console.log(`wrote ${goldPathForImage(caseDir, "candidate")}`);
  }
  if (!raw.reference && !raw.candidate && raw.dimensions?.length) {
    saveDimGold(
      goldPathForImage(caseDir, "reference"),
      raw.dimensions.map((d) => ({ ...d, verified: true as const })),
    );
    console.log(`wrote ${goldPathForImage(caseDir, "reference")} (from dimensions[])`);
  }
}

const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;

const latestDir = join(caseDir, "reviews", "latest");
const latestHtml = join(latestDir, "review.html");
if (!existsSync(latestHtml)) {
  console.error(`No review at ${latestHtml}. Run: npm run eval -- ${caseDir}`);
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".js": "text/javascript",
  ".css": "text/css",
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, caseDir }));
    return;
  }

  if (url.pathname === "/api/gold" && req.method === "POST") {
    try {
      const raw = JSON.parse(await readBody(req)) as {
        reference?: DimGold[];
        candidate?: DimGold[];
      };
      mkdirSync(join(caseDir, "gold"), { recursive: true });
      const ref = (raw.reference ?? []).map((d) => ({ ...d, verified: true as const }));
      const cand = (raw.candidate ?? []).map((d) => ({ ...d, verified: true as const }));
      if (ref.length) saveDimGold(goldPathForImage(caseDir, "reference"), ref);
      if (cand.length) saveDimGold(goldPathForImage(caseDir, "candidate"), cand);
      // Allow clearing: if arrays present but empty, write empty gold
      if (raw.reference && ref.length === 0) {
        saveDimGold(goldPathForImage(caseDir, "reference"), []);
      }
      if (raw.candidate && cand.length === 0) {
        saveDimGold(goldPathForImage(caseDir, "candidate"), []);
      }
      console.log(
        `gold saved: ref=${ref.length} cand=${cand.length} → ${join(caseDir, "gold")}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reference: ref.length, candidate: cand.length }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return;
  }

  let rel = url.pathname === "/" ? "/review.html" : url.pathname;
  rel = decodeURIComponent(rel).replace(/^\/+/, "");
  const filePath = join(latestDir, rel);
  if (!filePath.startsWith(latestDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/review.html`;
  console.log(`Review server for ${caseDir}`);
  console.log(`Open ${url}`);
  console.log(`Verify → gold POSTs to ${join(caseDir, "gold/")}`);
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    /* ignore */
  }
});
