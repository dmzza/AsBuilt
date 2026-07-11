/**
 * Local Eval UI — create cases, score, open review.
 *
 *   npm run eval:ui
 *   npm run eval:ui -- --port 8790
 */
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, basename } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  casesRoot,
  listCaseDirs,
  summarizeCase,
  runCase,
  slugify,
  saveMeta,
  loadMeta,
} from "../eval/src/runCase";
import { goldPathForImage, saveDimGold, type DimGold } from "../eval/src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "../eval/ui");
const CASES = casesRoot();

const args = process.argv.slice(2).filter((a) => a !== "--");
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8790;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".js": "text/javascript",
  ".css": "text/css",
  ".abl": "text/plain; charset=utf-8",
};

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toPng(buf: Buffer): Promise<Buffer> {
  return sharp(buf).png().toBuffer();
}

function uniqueCaseDir(id: string): string {
  let dir = join(CASES, id);
  if (!existsSync(dir)) return dir;
  let i = 2;
  while (existsSync(join(CASES, `${id}_${i}`))) i++;
  return join(CASES, `${id}_${i}`);
}

function serveFile(res: import("node:http").ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;

  try {
    if (path === "/api/cases" && req.method === "GET") {
      mkdirSync(CASES, { recursive: true });
      const cases = listCaseDirs(CASES).map(summarizeCase);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cases }));
      return;
    }

    if (path === "/api/cases" && req.method === "POST") {
      const raw = JSON.parse((await readBody(req)).toString("utf8")) as {
        name?: string;
        referenceBase64: string;
        referenceName?: string;
        candidateImageBase64?: string;
        ablFiles?: { relativePath: string; base64: string }[];
        runNow?: boolean;
      };
      if (!raw.referenceBase64) throw new Error("reference drawing required");

      const baseName =
        raw.name?.trim() ||
        slugify(raw.referenceName || "drawing");
      const caseDir = uniqueCaseDir(slugify(baseName));
      const id = basename(caseDir);
      mkdirSync(join(caseDir, "gold"), { recursive: true });

      const refBuf = await toPng(Buffer.from(raw.referenceBase64, "base64"));
      writeFileSync(join(caseDir, "reference.png"), refBuf);

      if (raw.candidateImageBase64) {
        const cand = await toPng(Buffer.from(raw.candidateImageBase64, "base64"));
        writeFileSync(join(caseDir, "candidate.png"), cand);
        saveMeta(caseDir, {
          title: raw.name?.trim() || id,
          tolerances: { dimInches: 0.5, spanPx: 48, layoutMismatch: 0.35 },
        });
      } else if (raw.ablFiles?.length) {
        const projectDir = join(caseDir, "project");
        for (const f of raw.ablFiles) {
          const rel = f.relativePath.replace(/^\/+/, "").replace(/\.\./g, "");
          // Strip a common top folder prefix if present (webkitdirectory)
          const parts = rel.split("/");
          const stripped =
            parts.length > 1 && !parts[0]!.endsWith(".abl")
              ? parts.slice(1).join("/")
              : rel;
          const dest = join(projectDir, stripped || basename(rel));
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, Buffer.from(f.base64, "base64"));
        }
        saveMeta(caseDir, {
          title: raw.name?.trim() || id,
          branch: "asbuilt",
          asbuiltProject: "project",
          tolerances: { dimInches: 0.5, spanPx: 48, layoutMismatch: 0.35 },
        });
      } else {
        throw new Error("Provide a candidate image or .abl project files");
      }

      let scored = false;
      let overall = 0;
      let scoreError: string | undefined;
      if (raw.runNow !== false) {
        try {
          const result = await runCase(caseDir);
          scored = true;
          overall = result.provisionalScore.overall;
        } catch (e) {
          scoreError = (e as Error).message;
          console.error(`score failed for ${id}:`, e);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          id,
          path: caseDir,
          scored,
          overall,
          error: scoreError,
          hasReview: existsSync(join(caseDir, "reviews", "latest", "review.html")),
        }),
      );
      return;
    }

    const scoreMatch = path.match(/^\/api\/cases\/([^/]+)\/score$/);
    if (scoreMatch && req.method === "POST") {
      const id = decodeURIComponent(scoreMatch[1]!);
      const caseDir = join(CASES, id);
      if (!existsSync(join(caseDir, "reference.png"))) throw new Error(`unknown case ${id}`);
      const result = await runCase(caseDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          overall: result.provisionalScore.overall,
          dims: result.provisionalScore.dims,
          spans: result.provisionalScore.spans,
          findings: result.findings.length,
        }),
      );
      return;
    }

    // Gold save from review UI (same shape as eval-review)
    const goldMatch = path.match(/^\/api\/cases\/([^/]+)\/gold$/);
    if (goldMatch && req.method === "POST") {
      const id = decodeURIComponent(goldMatch[1]!);
      const caseDir = join(CASES, id);
      const raw = JSON.parse((await readBody(req)).toString("utf8")) as {
        reference?: DimGold[];
        candidate?: DimGold[];
      };
      mkdirSync(join(caseDir, "gold"), { recursive: true });
      const ref = (raw.reference ?? []).map((d) => ({ ...d, verified: true as const }));
      const cand = (raw.candidate ?? []).map((d) => ({ ...d, verified: true as const }));
      saveDimGold(goldPathForImage(caseDir, "reference"), ref);
      saveDimGold(goldPathForImage(caseDir, "candidate"), cand);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reference: ref.length, candidate: cand.length }));
      return;
    }

    if (path === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, casesRoot: CASES }));
      return;
    }

    // Review assets: /review/:id/...
    const reviewMatch = path.match(/^\/review\/([^/]+)\/(.*)$/);
    if (reviewMatch) {
      const id = decodeURIComponent(reviewMatch[1]!);
      const rel = decodeURIComponent(reviewMatch[2] || "review.html") || "review.html";
      const latest = join(CASES, id, "reviews", "latest");
      const reviewHtml = join(latest, "review.html");

      if (rel === "review.html" || rel === "") {
        if (!existsSync(reviewHtml)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>No review</title>
<style>body{font-family:system-ui;background:#12110f;color:#f0eee6;padding:2rem}
a{color:#6b9fff}</style></head><body>
<h1>No review yet for <code>${id}</code></h1>
<p>Score the case first from the <a href="/">Eval UI</a>, then open Review.</p>
</body></html>`);
          return;
        }
        let html = readFileSync(reviewHtml, "utf8");
        html = html.replace(
          "const r = await fetch('/api/gold',",
          `const r = await fetch('/api/cases/${id}/gold',`,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      const filePath = join(latest, rel);
      if (!filePath.startsWith(latest)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      serveFile(res, filePath);
      return;
    }

    if (path === "/review" || path.startsWith("/review/")) {
      // /review/:id → redirect to trailing slash index
      const m = path.match(/^\/review\/([^/]+)\/?$/);
      if (m) {
        res.writeHead(302, { Location: `/review/${m[1]}/` });
        res.end();
        return;
      }
    }

    // Static UI
    const uiPath = path === "/" ? join(UI_DIR, "index.html") : join(UI_DIR, path.replace(/^\/+/, ""));
    if (uiPath.startsWith(UI_DIR) && existsSync(uiPath) && !statSync(uiPath).isDirectory()) {
      serveFile(res, uiPath);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    console.error(e);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
});

// Rewrite review gold fetch path is handled when serving review.html
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Eval UI → ${url}`);
  console.log(`Cases     ${CASES}`);
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    /* ignore */
  }
});
