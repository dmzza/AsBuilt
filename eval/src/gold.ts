import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DimGold, DimReading, ReviewDecision } from "./types";

export function loadDimGold(path: string): DimGold[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { dimensions?: DimReading[] } | DimReading[];
  const list = Array.isArray(raw) ? raw : (raw.dimensions ?? []);
  return list
    .filter((d) => d.verified === true && d.span?.a && d.span?.b)
    .map((d) => ({ ...d, verified: true as const }));
}

export function saveDimGold(path: string, dims: DimGold[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        note: "Image-anchored gold dims: value + span endpoints in pixel space. No ABL entity IDs.",
        dimensions: dims,
      },
      null,
      2,
    ) + "\n",
  );
}

/** Promote readings to gold (requires span). */
export function promoteToGold(readings: DimReading[]): DimGold[] {
  return readings
    .filter((r) => r.verified && r.span?.a && r.span?.b)
    .map((r) => ({ ...r, verified: true as const }));
}

export function applyDimCorrections(
  readings: DimReading[],
  decisions: ReviewDecision[],
): DimReading[] {
  const byId = new Map(readings.map((r) => [r.id, { ...r }]));
  for (const d of decisions) {
    if (!d.dimId) continue;
    const cur = byId.get(d.dimId);
    if (!cur) continue;
    if (d.action === "reject") {
      byId.delete(d.dimId);
      continue;
    }
    if (d.action === "correct" && d.dimPatch) {
      Object.assign(cur, d.dimPatch);
    }
    if (d.action === "accept" || d.action === "correct") {
      cur.verified = true;
    }
    byId.set(d.dimId, cur);
  }
  return [...byId.values()];
}

export function loadReviews(path: string): ReviewDecision[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as ReviewDecision[];
}

export function saveReviews(path: string, decisions: ReviewDecision[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(decisions, null, 2) + "\n");
}

export function goldPathForImage(caseDir: string, which: "reference" | "candidate"): string {
  return join(caseDir, "gold", `${which}.dims.json`);
}
