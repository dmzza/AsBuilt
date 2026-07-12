/**
 * Interactive in-place review UI: dimensions and findings live on the image
 * (SVG overlay). Select a span on the drawing, drag endpoints, verify to gold.
 *
 * When opened via `npm run eval:review` (local server), Verify/Export POST gold
 * into the case's gold/ directory. file:// fallback still downloads JSON.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScorePlanPairResult, VisionStatus } from "./types";
import { deriveVisionStatus, visionStatusTone } from "./vision/status";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function visionBannerHtml(vs: VisionStatus): string {
  const tone = visionStatusTone(vs.availability);
  // Success: header pill is enough — don't steal vertical space.
  if (vs.availability === "used") return "";
  const how =
    vs.availability === "missing_key"
      ? "Add <code>ANTHROPIC_API_KEY</code> (or <code>OPENAI_API_KEY</code>) to <code>.env</code> for dim/structure vision. Structure walls-only redraw also needs <code>GEMINI_API_KEY</code> (Nano Banana). Then re-score this case."
      : vs.availability === "disabled"
        ? "Re-run with vision enabled to propose dimensions."
        : vs.availability === "gold_only"
          ? "Live AI extract was not needed for dims; set an API key if you want topology vision too."
          : "Check the notes below, fix the failure, and re-score.";
  return `<div class="ai-banner ai-${tone}" role="alert">
    <div class="ai-banner-title">
      <strong>AI review: ${esc(vs.label)}</strong>
      <span class="ai-pill ai-pill-${tone}">${esc(vs.availability.replace(/_/g, " "))}</span>
    </div>
    <p>${esc(vs.summary)}</p>
    <p class="ai-how">${how}</p>
  </div>`;
}

export function writeReviewReport(
  outDir: string,
  result: ScorePlanPairResult,
  opts?: { caseId?: string },
): string {
  const path = join(outDir, "review.html");
  const score = result.provisionalScore;
  const title = opts?.caseId ? `Plan fidelity — ${opts.caseId}` : "Plan fidelity review";
  const vs =
    result.visionStatus ??
    deriveVisionStatus({
      notes: result.notes,
      referenceDimCount: result.referenceDimsUsed.length,
      candidateDimCount: result.candidateDimsUsed.length,
      usedReferenceGold: result.referenceDimsUsed.some((d) => d.verified),
      usedCandidateGold: result.candidateDimsUsed.some((d) => d.verified),
    });
  const tone = visionStatusTone(vs.availability);
  const refEmptyHint =
    result.referenceDimsUsed.length === 0
      ? vs.availability === "missing_key" || vs.availability === "failed"
        ? `<div class="empty-hint">No reference dims — AI did not propose any. ${esc(vs.label)}.</div>`
        : `<div class="empty-hint">No reference dimensions in this run.</div>`
      : "";
  const candEmptyHint =
    result.candidateDimsUsed.length === 0
      ? vs.availability === "missing_key" || vs.availability === "failed"
        ? `<div class="empty-hint">No candidate dims — AI did not propose any. ${esc(vs.label)}.</div>`
        : `<div class="empty-hint">No candidate dimensions in this run.</div>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #141311;
    --panel: #1c1b18;
    --line: #333029;
    --text: #f0eee6;
    --muted: #8a8678;
    --accent: #6b9fff;
    --ok: #3ecf8e;
    --warn: #e2a350;
    --bad: #e86a5c;
    --cand: #c084fc;
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header {
    flex: 0 0 auto;
    display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
    padding: 0.65rem 1rem; border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  h1 { font-size: 0.95rem; font-weight: 600; margin: 0; letter-spacing: 0.04em; text-transform: uppercase; }
  .scores { display: flex; gap: 0.9rem; font-variant-numeric: tabular-nums; font-size: 0.8rem; color: var(--muted); }
  .scores b { color: var(--accent); font-weight: 600; }
  .toolbar { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-left: auto; align-items: center; }
  .toolbar button, .chip, .inspector button, .list button {
    background: #2a2824; color: var(--text); border: 1px solid #444038;
    padding: 0.3rem 0.65rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem;
  }
  .toolbar button.active { background: #2f3f66; border-color: var(--accent); }
  .toolbar button.primary, .inspector button.primary {
    background: #1f3d2e; border-color: #3a6b52; color: #c8f0d8;
  }
  .server-pill, .ai-status-pill {
    font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 999px;
    border: 1px solid #444; color: var(--muted);
  }
  .server-pill.on { color: var(--ok); border-color: #2a5a40; }
  .ai-status-pill.ok { color: var(--ok); border-color: #2a5a40; }
  .ai-status-pill.warn { color: var(--warn); border-color: #6a5020; background: #2a2210; }
  .ai-status-pill.bad { color: var(--bad); border-color: #6a3030; background: #2a1515; font-weight: 600; }
  .ai-banner {
    flex: 0 0 auto;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .ai-banner p { margin: 0.35rem 0 0; }
  .ai-banner .ai-how { color: var(--muted); font-size: 0.8rem; }
  .ai-banner code {
    font-size: 0.78rem; background: #0d0c0a; padding: 0.1rem 0.35rem; border-radius: 3px;
  }
  .ai-banner-title { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .ai-banner.ai-ok { background: #14241c; border-bottom-color: #2a5a40; color: #c8f0d8; }
  .ai-banner.ai-ok span { color: #9bc4ae; font-weight: 400; margin-left: 0.5rem; }
  .ai-banner.ai-warn { background: #2a2210; border-bottom-color: #6a5020; color: #f0d9a8; }
  .ai-banner.ai-bad { background: #2a1515; border-bottom-color: #6a3030; color: #f0d0d0; }
  .ai-pill {
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 0.12rem 0.45rem; border-radius: 3px; border: 1px solid;
  }
  .ai-pill-ok { border-color: #2a5a40; color: var(--ok); }
  .ai-pill-warn { border-color: #6a5020; color: var(--warn); }
  .ai-pill-bad { border-color: #6a3030; color: var(--bad); }
  .empty-hint {
    font-size: 0.78rem; color: var(--warn); background: #2a2210;
    border: 1px solid #6a5020; border-radius: 4px; padding: 0.5rem 0.65rem; margin: 0.35rem 0 0.6rem;
  }
  main { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
  .stage-wrap { position: relative; overflow: auto; background: #0d0c0a; touch-action: none; }
  .stage {
    position: relative;
    display: inline-block;
    margin: 1rem;
    line-height: 0;
    box-shadow: 0 0 0 1px var(--line);
    /* Zoom via explicit width (not CSS transform) so layout == visual. */
  }
  .stage img {
    display: block;
    max-width: none;
    height: auto;
    background: #f5f3ec;
    user-select: none;
    -webkit-user-drag: none;
    pointer-events: none;
  }
  .stage svg.overlay {
    position: absolute; left: 0; top: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    touch-action: none;
  }
  .stage svg.overlay.dragging { pointer-events: all; cursor: grabbing; }
  .stage svg.overlay .hit { pointer-events: stroke; cursor: pointer; }
  .stage svg.overlay .handle,
  .stage svg.overlay .handle-hit { pointer-events: all; cursor: grab; touch-action: none; }
  .stage svg.overlay .handle:active,
  .stage svg.overlay .handle-hit:active { cursor: grabbing; }
  .stage svg.overlay .handle-hit { fill: transparent; stroke: none; }
  .dim-group { pointer-events: none; }
  .dim-group .hit, .dim-group .handle, .dim-group .handle-hit, .dim-group .label-hit { pointer-events: all; }
  .dim-group.dim-ref .span { stroke: var(--accent); }
  .dim-group.dim-cand .span { stroke: var(--cand); }
  .dim-group.verified .span { stroke: var(--ok); }
  .dim-group.selected .span { stroke-width: 4.5; filter: drop-shadow(0 0 4px rgba(107,159,255,0.7)); }
  .dim-group:not(.selected) .span { opacity: 0.55; }
  .dim-group.selected { opacity: 1; }
  .dim-group .span { fill: none; stroke-width: 3; stroke-linecap: round; }
  .dim-group .hit { fill: none; stroke: transparent; stroke-width: 18; }
  .dim-group .handle { fill: #fff; stroke-width: 2.5; }
  .dim-group.dim-ref .handle { stroke: var(--accent); }
  .dim-group.dim-cand .handle { stroke: var(--cand); }
  .dim-group.verified .handle { stroke: var(--ok); }
  .dim-group .leader {
    fill: none; stroke-width: 1.25; stroke-dasharray: 3 3; opacity: 0.85;
  }
  .dim-group.dim-ref .leader { stroke: var(--accent); }
  .dim-group.dim-cand .leader { stroke: var(--cand); }
  .dim-group.verified .leader { stroke: var(--ok); }
  .label-chip {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    pointer-events: all;
    cursor: pointer;
  }
  .label-chip rect { fill: rgba(20,19,17,0.92); stroke-width: 1.5; }
  .dim-group.dim-ref .label-chip rect { stroke: var(--accent); }
  .dim-group.dim-cand .label-chip rect { stroke: var(--cand); }
  .dim-group.verified .label-chip rect { stroke: var(--ok); }
  .dim-group.selected .label-chip rect { stroke-width: 2.5; fill: rgba(30,40,70,0.95); }
  .label-chip text { fill: #f5f3ec; }
  .alt-span { fill: none; stroke: var(--warn); stroke-width: 2; stroke-dasharray: 6 4; opacity: 0.7; pointer-events: stroke; cursor: pointer; }
  .structure-wall {
    fill: none; stroke: #e2a350; stroke-width: 3.5; stroke-linecap: round; opacity: 0.9;
    pointer-events: stroke; cursor: pointer;
  }
  .structure-wall.cand { stroke: #d4a017; stroke-dasharray: 10 5; opacity: 0.75; }
  .structure-wall.selected { stroke-width: 5; filter: drop-shadow(0 0 4px rgba(226,163,80,0.7)); }
  .structure-junction {
    fill: #1c1b18; stroke: #e2a350; stroke-width: 2.5;
    pointer-events: all; cursor: pointer;
  }
  .structure-junction.cand { stroke: #d4a017; }
  .structure-junction.selected { fill: #e2a350; }
  .finding-box {
    fill: rgba(232,106,92,0.12); stroke: var(--bad); stroke-width: 2; stroke-dasharray: 8 5;
    pointer-events: all; cursor: pointer;
  }
  .finding-box.selected { fill: rgba(232,106,92,0.28); stroke-width: 3; }
  .side {
    border-left: 1px solid var(--line); background: var(--panel);
    display: flex; flex-direction: column; min-height: 0;
  }
  .side-scroll { flex: 1; overflow: auto; padding: 0.85rem 1rem 1.5rem; }
  h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 1rem 0 0.45rem; }
  h2:first-child { margin-top: 0; }
  .hint { font-size: 0.78rem; color: var(--muted); line-height: 1.45; margin: 0 0 0.75rem; }
  .inspector {
    border: 1px solid var(--line); border-radius: 6px; padding: 0.75rem;
    background: #161512; min-height: 7rem;
  }
  .inspector.empty { color: var(--muted); font-size: 0.85rem; }
  .inspector .row { display: flex; gap: 0.4rem; align-items: center; margin: 0.35rem 0; flex-wrap: wrap; }
  .inspector label { font-size: 0.72rem; color: var(--muted); }
  .inspector input[type=text] {
    background: #0d0c0a; color: var(--text); border: 1px solid #444038;
    border-radius: 3px; padding: 0.25rem 0.4rem; font-size: 0.85rem;
  }
  .inspector .value-input { width: 7rem; font-family: ui-monospace, monospace; }
  .badge {
    display: inline-block; font-size: 0.68rem; padding: 0.1rem 0.4rem;
    border-radius: 3px; border: 1px solid #444; color: var(--muted);
  }
  .badge.ok { color: var(--ok); border-color: #2a5a40; }
  .badge.ref { color: var(--accent); border-color: #3a5080; }
  .badge.cand { color: var(--cand); border-color: #6b4a90; }
  .list { display: flex; flex-direction: column; gap: 0.25rem; }
  .list button {
    text-align: left; display: flex; justify-content: space-between; gap: 0.5rem;
    width: 100%;
  }
  .list button.selected { outline: 1px solid var(--accent); }
  .list button .meta { color: var(--muted); font-size: 0.72rem; }
  .notes { font-size: 0.72rem; color: var(--muted); white-space: pre-wrap; margin-top: 0.5rem; }
  .zoom-bar { display: flex; gap: 0.35rem; align-items: center; font-size: 0.75rem; color: var(--muted); }
  #toast {
    position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
    background: #1f3d2e; color: #c8f0d8; border: 1px solid #3a6b52;
    padding: 0.55rem 1rem; border-radius: 6px; font-size: 0.85rem;
    opacity: 0; pointer-events: none; transition: opacity 0.2s; z-index: 50;
    max-width: 90vw;
  }
  #toast.show { opacity: 1; }
  #toast.err { background: #3d1f1f; border-color: #6a4040; color: #f0d0d0; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="scores">
    <span>overall <b>${(score.overall * 100).toFixed(1)}%</b></span>
    <span>layout <b>${(score.layout * 100).toFixed(1)}%</b></span>
    <span>dims <b>${(score.dims * 100).toFixed(1)}%</b></span>
    <span>spans <b>${(score.spans * 100).toFixed(1)}%</b></span>
  </div>
  <div class="toolbar">
    <span class="ai-status-pill ${tone}" id="ai-status-pill" title="${esc(vs.summary)}">${esc(vs.label)}</span>
    <span class="server-pill" id="server-pill">file mode</span>
    <div class="zoom-bar">
      <button type="button" id="zoom-out">−</button>
      <span id="zoom-label">100%</span>
      <button type="button" id="zoom-in">+</button>
      <button type="button" id="zoom-fit">Fit</button>
    </div>
    <button type="button" class="active" data-bg="onion_skin.png">Onion</button>
    <button type="button" data-bg="reference.png">Reference</button>
    <button type="button" data-bg="aligned_candidate.png">Aligned</button>
    <button type="button" data-bg="candidate.png">Candidate</button>
    <button type="button" data-bg="layout_diff.png">Layout diff</button>
    ${result.overlays.structureRefPng ? `<button type="button" data-bg="${esc(result.overlays.structureRefPng)}">Struct ref</button>` : ""}
    ${result.overlays.structureCandPng ? `<button type="button" data-bg="${esc(result.overlays.structureCandPng)}">Struct cand</button>` : ""}
    <button type="button" id="toggle-ref" class="active">Ref dims</button>
    <button type="button" id="toggle-cand" class="active">Cand dims</button>
    <button type="button" id="toggle-ref-struct" class="active">Ref structure</button>
    <button type="button" id="toggle-cand-struct">Cand structure</button>
    <button type="button" id="toggle-findings" class="active">Findings</button>
    <button type="button" class="primary" id="export-gold">Save all gold</button>
  </div>
</header>
${visionBannerHtml(vs)}
<main>
  <div class="stage-wrap" id="stage-wrap">
    <div class="stage" id="stage">
      <img id="bg" src="onion_skin.png" alt="plan"/>
      <svg class="overlay" id="overlay" xmlns="http://www.w3.org/2000/svg"></svg>
    </div>
  </div>
  <aside class="side">
    <div class="side-scroll">
      <p class="hint">
        Layers: <b>dims</b> (annotation values/spans) vs <b>structure</b> (wall junctions/spans). Toggle independently.
        Use <b>Struct ref/cand</b> backgrounds to inspect the walls-only redraw used for structure extract.
        Drag dim endpoint handles to correct spans, then <b>Verify → gold</b>.
      </p>
      ${
        result.structureCleaned
          ? `<p class="hint">Structure redraw: ref <b>${esc(result.structureCleaned.reference)}</b>, cand <b>${esc(result.structureCleaned.candidate)}</b>.</p>`
          : ""
      }
      <h2>Selected</h2>
      <div class="inspector empty" id="inspector">Click a dimension or finding on the plan.</div>
      <h2>Reference dims <span class="badge ref" id="ref-count">0</span></h2>
      ${refEmptyHint}
      <div class="list" id="ref-list"></div>
      <h2>Candidate dims <span class="badge cand" id="cand-count">0</span></h2>
      ${candEmptyHint}
      <div class="list" id="cand-list"></div>
      <h2>Ref structure <span class="badge" id="ref-struct-count">0</span></h2>
      <div class="list" id="ref-struct-list"></div>
      <h2>Cand structure <span class="badge" id="cand-struct-count">0</span></h2>
      <div class="list" id="cand-struct-list"></div>
      <h2>Findings <span class="badge" id="find-count">0</span></h2>
      <div class="list" id="find-list"></div>
      <h2>Notes</h2>
      <div class="notes" id="notes"></div>
    </div>
  </aside>
</main>
<div id="toast"></div>
<script>
const state = {
  reference: ${JSON.stringify(result.referenceDimsUsed)},
  candidate: ${JSON.stringify(result.candidateDimsUsed)},
  referenceStructure: ${JSON.stringify(result.referenceStructure ?? { junctions: [], wallSpans: [] })},
  candidateStructure: ${JSON.stringify(result.candidateStructure ?? { junctions: [], wallSpans: [] })},
  structureCleaned: ${JSON.stringify(result.structureCleaned ?? null)},
  overlays: ${JSON.stringify(result.overlays)},
  findings: ${JSON.stringify(result.findings)},
  transform: ${JSON.stringify(result.transform)},
  decisions: [],
  notes: ${JSON.stringify(result.notes)},
  visionStatus: ${JSON.stringify(vs)},
  selected: null,
  showRef: true,
  showCand: true,
  showRefStruct: true,
  showCandStruct: false,
  showFindings: true,
  bg: 'onion_skin.png',
  zoom: 1,
  imgW: 0,
  imgH: 0,
  drag: null,
  dragMoved: false,
  server: false,
};

function isCandNativeBg() {
  return state.bg === 'candidate.png' || state.bg === (state.overlays && state.overlays.structureCandPng);
}

const bgEl = document.getElementById('bg');
const overlay = document.getElementById('overlay');
const stage = document.getElementById('stage');
const inspector = document.getElementById('inspector');
const toastEl = document.getElementById('toast');

function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.className = err ? 'show err' : 'show';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = ''; }, 2800);
}

async function detectServer() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return;
    const j = await r.json();
    state.server = !!j.ok;
    const pill = document.getElementById('server-pill');
    pill.textContent = state.server ? 'server · saves to case' : 'file mode';
    pill.classList.toggle('on', state.server);
  } catch {
    state.server = false;
  }
}

function goldPayload() {
  return {
    version: 1,
    note: 'Image-anchored gold: value + span endpoints in pixel space.',
    reference: state.reference.filter(d => d.verified).map(d => ({ ...d, verified: true })),
    candidate: state.candidate.filter(d => d.verified).map(d => ({ ...d, verified: true })),
  };
}

async function persistGold(reason) {
  const payload = goldPayload();
  const n = payload.reference.length + payload.candidate.length;
  if (state.server) {
    try {
      const r = await fetch('/api/gold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      toast(\`\${reason} · saved \${n} gold dim(s) to case\`);
      return j;
    } catch (e) {
      toast('Save failed: ' + e.message, true);
      throw e;
    }
  }
  // file:// fallback
  download('gold.dims.json', payload);
  toast(\`\${reason} · downloaded gold.dims.json (\${n} dims). Import with eval:review --import-gold\`);
}

function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function applyTransform(p, t) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const x = t.scale * p.x, y = t.scale * p.y;
  return { x: c * x - s * y + t.tx, y: s * x + c * y + t.ty };
}

function candidateInRefSpace(d) {
  if (isCandNativeBg()) return d;
  const t = state.transform;
  const map = (p) => applyTransform(p, t);
  return {
    ...d,
    span: { a: map(d.span.a), b: map(d.span.b) },
    alternateSpans: (d.alternateSpans || []).map(s => ({ a: map(s.a), b: map(s.b) })),
  };
}

function findDim(side, id) {
  return (side === 'reference' ? state.reference : state.candidate).find(d => d.id === id);
}

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

/** Place label chip off the wall: perpendicular offset from span midpoint. */
function labelPlacement(span, tw, th) {
  const dx = span.b.x - span.a.x;
  const dy = span.b.y - span.a.y;
  const len = Math.hypot(dx, dy) || 1;
  // outward normal (prefer upward-ish for horizontal walls so labels sit outside)
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; } // flip so offset tends "above" in screen space
  const offset = 36;
  const m = mid(span.a, span.b);
  const anchor = { x: m.x + nx * 10, y: m.y + ny * 10 };
  const lx = m.x + nx * offset - tw / 2;
  const ly = m.y + ny * offset - th / 2;
  return { lx, ly, anchor, leaderEnd: { x: m.x + nx * offset, y: m.y + ny * offset } };
}

function recordCorrect(dimId, patch) {
  state.decisions.push({ dimId, action: 'correct', dimPatch: patch, at: new Date().toISOString() });
}

function setSelected(sel, opts = {}) {
  state.selected = sel;
  if (!opts.skipOverlay) renderOverlay();
  else syncSelectionClasses();
  renderLists();
  renderInspector();
  if (sel?.kind === 'dim' && !opts.skipScroll) scrollDimIntoView(sel.side, sel.id);
}

/** Update selected classes without destroying SVG nodes (keeps pointer capture alive). */
function syncSelectionClasses() {
  overlay.querySelectorAll('.dim-group').forEach(g => {
    const on = state.selected?.kind === 'dim'
      && g.getAttribute('data-side') === state.selected.side
      && g.getAttribute('data-id') === state.selected.id;
    g.classList.toggle('selected', on);
  });
  overlay.querySelectorAll('[data-struct]').forEach(el => {
    const on = (state.selected?.kind === 'wall' || state.selected?.kind === 'junction')
      && el.getAttribute('data-struct') === state.selected.kind
      && el.getAttribute('data-side') === state.selected.side
      && el.getAttribute('data-id') === state.selected.id;
    el.classList.toggle('selected', on);
  });
  overlay.querySelectorAll('.finding-box').forEach(el => {
    const on = state.selected?.kind === 'finding'
      && el.getAttribute('data-finding') === state.selected.id;
    el.classList.toggle('selected', on);
  });
}

/** Screen-stable handle radius in image space (zoom otherwise shrinks hit targets). */
function handleRadii(selected) {
  const z = Math.max(0.05, state.zoom);
  const vis = Math.max(selected ? 9 : 7, (selected ? 11 : 9) / z);
  // Cap image-space hit radius so zoomed-out pads don't swallow neighboring handles.
  const hit = Math.min(48, Math.max(vis + 6, 16 / z));
  return { vis, hit };
}

function scrollDimIntoView(side, id) {
  const g = overlay.querySelector(\`[data-side="\${side}"][data-id="\${CSS.escape(id)}"]\`);
  if (!g) return;
  const wrap = document.getElementById('stage-wrap');
  const bb = g.getBBox();
  // Stage CSS width is imgW*zoom, so user-space × zoom == layout pixels.
  const zx = state.zoom;
  wrap.scrollTo({
    left: Math.max(0, (bb.x + bb.width / 2) * zx - wrap.clientWidth / 2),
    top: Math.max(0, (bb.y + bb.height / 2) * zx - wrap.clientHeight / 2),
    behavior: 'smooth',
  });
}

function renderOverlay() {
  if (!state.imgW) return;
  overlay.setAttribute('viewBox', \`0 0 \${state.imgW} \${state.imgH}\`);
  overlay.setAttribute('width', state.imgW);
  overlay.setAttribute('height', state.imgH);

  const parts = [];

  if (state.showFindings && !isCandNativeBg()) {
    for (const f of state.findings) {
      const b = f.alignedBBox || f.referenceBBox;
      if (!b) continue;
      const sel = state.selected?.kind === 'finding' && state.selected.id === f.id;
      parts.push(\`<rect class="finding-box\${sel ? ' selected' : ''}" data-finding="\${escAttr(f.id)}" x="\${b.x}" y="\${b.y}" width="\${b.w}" height="\${b.h}"/>\`);
    }
  }

  const drawSide = (side, show) => {
    if (!show) return;
    for (const raw of (side === 'reference' ? state.reference : state.candidate)) {
      const d = side === 'candidate' ? candidateInRefSpace(raw) : raw;
      if (isCandNativeBg() && side === 'reference') continue;
      const selected = state.selected?.kind === 'dim' && state.selected.side === side && state.selected.id === raw.id;
      const cls = [
        'dim-group',
        side === 'reference' ? 'dim-ref' : 'dim-cand',
        raw.verified ? 'verified' : '',
        selected ? 'selected' : '',
      ].filter(Boolean).join(' ');

      for (let i = 0; i < (d.alternateSpans || []).length; i++) {
        const alt = d.alternateSpans[i];
        parts.push(\`<line class="alt-span" data-side="\${side}" data-id="\${escAttr(raw.id)}" data-alt="\${i}" x1="\${alt.a.x}" y1="\${alt.a.y}" x2="\${alt.b.x}" y2="\${alt.b.y}"/>\`);
      }

      const label = raw.valueText || (raw.valueInches.toFixed(2) + '"');
      const tw = Math.max(54, label.length * 8 + 20);
      const th = 20;
      const place = labelPlacement(d.span, tw, th);
      const { vis: handleR, hit: hitR } = handleRadii(selected);

      parts.push(\`<g class="\${cls}" data-side="\${side}" data-id="\${escAttr(raw.id)}">
        <line class="hit" x1="\${d.span.a.x}" y1="\${d.span.a.y}" x2="\${d.span.b.x}" y2="\${d.span.b.y}"/>
        <line class="span" x1="\${d.span.a.x}" y1="\${d.span.a.y}" x2="\${d.span.b.x}" y2="\${d.span.b.y}"/>
        <line class="leader" x1="\${place.anchor.x}" y1="\${place.anchor.y}" x2="\${place.leaderEnd.x}" y2="\${place.leaderEnd.y}"/>
        <circle class="handle-hit" data-which="a" cx="\${d.span.a.x}" cy="\${d.span.a.y}" r="\${hitR}"/>
        <circle class="handle-hit" data-which="b" cx="\${d.span.b.x}" cy="\${d.span.b.y}" r="\${hitR}"/>
        <circle class="handle" data-which="a" cx="\${d.span.a.x}" cy="\${d.span.a.y}" r="\${handleR}"/>
        <circle class="handle" data-which="b" cx="\${d.span.b.x}" cy="\${d.span.b.y}" r="\${handleR}"/>
        <g class="label-chip label-hit" transform="translate(\${place.lx}, \${place.ly})">
          <rect x="0" y="0" width="\${tw}" height="\${th}" rx="3"/>
          <text x="8" y="14">\${escXml(label)}\${raw.verified ? ' ✓' : ''}</text>
        </g>
      </g>\`);
    }
  };

  drawSide('reference', state.showRef);
  drawSide('candidate', state.showCand);

  const drawStructure = (side, show) => {
    if (!show) return;
    // Candidate-native canvases (raw cand / cleaned cand) hide ref structure.
    if (isCandNativeBg() && side === 'reference') return;
    // Cleaned-ref canvas is ref pixel space — keep ref structure, transform cand.
    const struct = side === 'reference' ? state.referenceStructure : state.candidateStructure;
    if (!struct) return;
    const mapPt = (p) => {
      if (side === 'reference' || isCandNativeBg()) return p;
      return applyTransform(p, state.transform);
    };
    const wallCls = side === 'reference' ? 'structure-wall' : 'structure-wall cand';
    const jCls = side === 'reference' ? 'structure-junction' : 'structure-junction cand';
    for (const w of struct.wallSpans || []) {
      const a = mapPt(w.a), b = mapPt(w.b);
      const sel = state.selected?.kind === 'wall' && state.selected.side === side && state.selected.id === w.id;
      parts.push(\`<line class="\${wallCls}\${sel ? ' selected' : ''}" data-struct="wall" data-side="\${side}" data-id="\${escAttr(w.id)}" x1="\${a.x}" y1="\${a.y}" x2="\${b.x}" y2="\${b.y}"/>\`);
    }
    for (const j of struct.junctions || []) {
      const p = mapPt(j.point);
      const sel = state.selected?.kind === 'junction' && state.selected.side === side && state.selected.id === j.id;
      parts.push(\`<circle class="\${jCls}\${sel ? ' selected' : ''}" data-struct="junction" data-side="\${side}" data-id="\${escAttr(j.id)}" cx="\${p.x}" cy="\${p.y}" r="7"/>\`);
    }
  };
  drawStructure('reference', state.showRefStruct);
  drawStructure('candidate', state.showCandStruct);

  overlay.innerHTML = parts.join('');
  bindOverlayEvents();
}

/** Mutate span/handle/label geometry in place during drag (no innerHTML rebuild). */
function updateDimGeometry(side, id) {
  const raw = findDim(side, id);
  if (!raw) return;
  const d = side === 'candidate' ? candidateInRefSpace(raw) : raw;
  const g = overlay.querySelector(\`[data-side="\${side}"][data-id="\${CSS.escape(id)}"]\`);
  if (!g) return;
  const selected = state.selected?.kind === 'dim' && state.selected.side === side && state.selected.id === id;
  const { vis: handleR, hit: hitR } = handleRadii(selected);
  g.querySelectorAll('.hit, .span').forEach(line => {
    line.setAttribute('x1', d.span.a.x);
    line.setAttribute('y1', d.span.a.y);
    line.setAttribute('x2', d.span.b.x);
    line.setAttribute('y2', d.span.b.y);
  });
  g.querySelectorAll('.handle-hit, .handle').forEach(c => {
    const which = c.getAttribute('data-which');
    const p = d.span[which];
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', c.classList.contains('handle-hit') ? hitR : handleR);
  });
  const label = raw.valueText || (raw.valueInches.toFixed(2) + '"');
  const tw = Math.max(54, label.length * 8 + 20);
  const th = 20;
  const place = labelPlacement(d.span, tw, th);
  const leader = g.querySelector('.leader');
  if (leader) {
    leader.setAttribute('x1', place.anchor.x);
    leader.setAttribute('y1', place.anchor.y);
    leader.setAttribute('x2', place.leaderEnd.x);
    leader.setAttribute('y2', place.leaderEnd.y);
  }
  const chip = g.querySelector('.label-chip');
  if (chip) chip.setAttribute('transform', \`translate(\${place.lx}, \${place.ly})\`);
}

function updateInspectorSpanOnly() {
  const sel = state.selected;
  if (!sel || sel.kind !== 'dim') return;
  const d = findDim(sel.side, sel.id);
  if (!d) return;
  const spanEl = inspector.querySelector('[data-span-coords]');
  if (spanEl) {
    spanEl.textContent = \`A(\${d.span.a.x.toFixed(0)}, \${d.span.a.y.toFixed(0)}) → B(\${d.span.b.x.toFixed(0)}, \${d.span.b.y.toFixed(0)})\`;
  }
}

function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Map viewport client coords → image/SVG user space.
 * Prefer getBoundingClientRect over getScreenCTM: CSS transforms on ancestors
 * (and some WebKit quirks) make CTM unreliable, while the overlay's visual
 * rect always reflects the current zoom whether we scale via width or transform.
 */
function clientToImage(evt) {
  const rect = overlay.getBoundingClientRect();
  if (!rect.width || !rect.height || !state.imgW || !state.imgH) return { x: 0, y: 0 };
  return {
    x: (evt.clientX - rect.left) * (state.imgW / rect.width),
    y: (evt.clientY - rect.top) * (state.imgH / rect.height),
  };
}

/** Display-space point of a dim endpoint (after candidate→ref alignment). */
function endpointDisplay(side, id, which) {
  const raw = findDim(side, id);
  if (!raw) return { x: 0, y: 0 };
  const d = side === 'candidate' ? candidateInRefSpace(raw) : raw;
  return { ...d.span[which] };
}

function displayToStored(side, displayPt) {
  if (side === 'reference' || isCandNativeBg()) return displayPt;
  const t = state.transform;
  const c = Math.cos(-t.rotation), s = Math.sin(-t.rotation);
  const dx = displayPt.x - t.tx, dy = displayPt.y - t.ty;
  const invS = 1 / t.scale;
  return { x: invS * (c * dx - s * dy), y: invS * (s * dx + c * dy) };
}

function bindOverlayEvents() {
  overlay.querySelectorAll('.dim-group').forEach(g => {
    const side = g.getAttribute('data-side');
    const id = g.getAttribute('data-id');
    g.querySelectorAll('.hit, .label-hit, .span').forEach(el => {
      el.addEventListener('click', (e) => {
        if (state.dragMoved) return; // suppress click after a drag
        e.stopPropagation();
        setSelected({ kind: 'dim', side, id });
      });
    });
    g.querySelectorAll('.handle-hit, .handle').forEach(h => {
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const which = h.getAttribute('data-which');
        // Select without rebuilding SVG — rebuilding would detach this handle and lose capture.
        state.selected = { kind: 'dim', side, id };
        // Grab offset in image space so the endpoint doesn't jump to the cursor.
        const imgPt = clientToImage(e);
        const handlePt = endpointDisplay(side, id, which);
        state.drag = {
          side,
          id,
          which,
          pointerId: e.pointerId,
          originX: e.clientX,
          originY: e.clientY,
          grabDx: imgPt.x - handlePt.x,
          grabDy: imgPt.y - handlePt.y,
        };
        state.dragMoved = false;
        syncSelectionClasses();
        renderLists();
        renderInspector();
        overlay.classList.add('dragging');
        try { h.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      });
    });
  });
  overlay.querySelectorAll('.alt-span').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const side = el.getAttribute('data-side');
      const id = el.getAttribute('data-id');
      const alt = Number(el.getAttribute('data-alt'));
      const d = findDim(side, id);
      if (!d || !d.alternateSpans?.[alt]) return;
      const prev = { a: { ...d.span.a }, b: { ...d.span.b } };
      d.span = { a: { ...d.alternateSpans[alt].a }, b: { ...d.alternateSpans[alt].b } };
      d.alternateSpans = [prev, ...d.alternateSpans.filter((_, i) => i !== alt)];
      recordCorrect(id, { span: d.span });
      setSelected({ kind: 'dim', side, id });
    });
  });
  overlay.querySelectorAll('.finding-box').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelected({ kind: 'finding', id: el.getAttribute('data-finding') });
    });
  });
  overlay.querySelectorAll('[data-struct]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelected({
        kind: el.getAttribute('data-struct'),
        side: el.getAttribute('data-side'),
        id: el.getAttribute('data-id'),
      });
    });
  });
}

function endDrag(e) {
  if (!state.drag) return;
  if (e && state.drag.pointerId != null && e.pointerId != null && e.pointerId !== state.drag.pointerId) return;
  const { side, id } = state.drag;
  const d = findDim(side, id);
  if (d && state.dragMoved) recordCorrect(id, { span: { a: { ...d.span.a }, b: { ...d.span.b } } });
  state.drag = null;
  overlay.classList.remove('dragging');
  // Final rebuild so labels/handles settle cleanly after zoom-compensated sizes.
  renderOverlay();
  renderInspector();
}

function onDragMove(e) {
  if (!state.drag) return;
  if (state.drag.pointerId != null && e.pointerId != null && e.pointerId !== state.drag.pointerId) return;
  const dx = e.clientX - state.drag.originX;
  const dy = e.clientY - state.drag.originY;
  if (!state.dragMoved && Math.hypot(dx, dy) < 3) return;
  state.dragMoved = true;
  const { side, id, which, grabDx = 0, grabDy = 0 } = state.drag;
  const d = findDim(side, id);
  if (!d) return;
  const img = clientToImage(e);
  d.span[which] = displayToStored(side, { x: img.x - grabDx, y: img.y - grabDy });
  updateDimGeometry(side, id);
  updateInspectorSpanOnly();
}

// Window-level listeners survive CSS zoom and keep dragging even if the capture target is lost.
window.addEventListener('pointermove', onDragMove);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

function renderLists() {
  const refList = document.getElementById('ref-list');
  const candList = document.getElementById('cand-list');
  const findList = document.getElementById('find-list');
  const refStructList = document.getElementById('ref-struct-list');
  const candStructList = document.getElementById('cand-struct-list');
  document.getElementById('ref-count').textContent = String(state.reference.length);
  document.getElementById('cand-count').textContent = String(state.candidate.length);
  document.getElementById('find-count').textContent = String(state.findings.length);
  const rs = state.referenceStructure || { junctions: [], wallSpans: [] };
  const cs = state.candidateStructure || { junctions: [], wallSpans: [] };
  document.getElementById('ref-struct-count').textContent = String(rs.junctions.length + rs.wallSpans.length);
  document.getElementById('cand-struct-count').textContent = String(cs.junctions.length + cs.wallSpans.length);

  refList.innerHTML = state.reference.map(d => listDimBtn('reference', d)).join('');
  candList.innerHTML = state.candidate.map(d => listDimBtn('candidate', d)).join('');
  findList.innerHTML = state.findings.map(f => {
    const sel = state.selected?.kind === 'finding' && state.selected.id === f.id;
    return \`<button type="button" class="\${sel ? 'selected' : ''}" data-pick-finding="\${escAttr(f.id)}">
      <span>\${escXml(f.kind)}</span>
      <span class="meta">\${escXml(f.status)}</span>
    </button>\`;
  }).join('');
  refStructList.innerHTML = listStructureBtns('reference', rs);
  candStructList.innerHTML = listStructureBtns('candidate', cs);

  refList.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setSelected({ kind: 'dim', side: 'reference', id: b.getAttribute('data-pick-dim') });
  }));
  candList.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setSelected({ kind: 'dim', side: 'candidate', id: b.getAttribute('data-pick-dim') });
  }));
  findList.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setSelected({ kind: 'finding', id: b.getAttribute('data-pick-finding') });
  }));
  refStructList.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setSelected({
      kind: b.getAttribute('data-struct-kind'),
      side: 'reference',
      id: b.getAttribute('data-pick-struct'),
    });
  }));
  candStructList.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setSelected({
      kind: b.getAttribute('data-struct-kind'),
      side: 'candidate',
      id: b.getAttribute('data-pick-struct'),
    });
  }));
}

function listStructureBtns(side, struct) {
  const walls = (struct.wallSpans || []).map(w => {
    const sel = state.selected?.kind === 'wall' && state.selected.side === side && state.selected.id === w.id;
    return \`<button type="button" class="\${sel ? 'selected' : ''}" data-struct-kind="wall" data-pick-struct="\${escAttr(w.id)}">
      <span>wall \${escXml(w.id)}</span>
      <span class="meta">(\${w.a.x.toFixed(0)},\${w.a.y.toFixed(0)})→(\${w.b.x.toFixed(0)},\${w.b.y.toFixed(0)})</span>
    </button>\`;
  });
  const juncs = (struct.junctions || []).map(j => {
    const sel = state.selected?.kind === 'junction' && state.selected.side === side && state.selected.id === j.id;
    return \`<button type="button" class="\${sel ? 'selected' : ''}" data-struct-kind="junction" data-pick-struct="\${escAttr(j.id)}">
      <span>\${escXml(j.kind || 'junction')} \${escXml(j.id)}</span>
      <span class="meta">(\${j.point.x.toFixed(0)},\${j.point.y.toFixed(0)})</span>
    </button>\`;
  });
  return walls.join('') + juncs.join('');
}

function listDimBtn(side, d) {
  const sel = state.selected?.kind === 'dim' && state.selected.side === side && state.selected.id === d.id;
  return \`<button type="button" class="\${sel ? 'selected' : ''}" data-pick-dim="\${escAttr(d.id)}">
    <span>\${escXml(d.valueText || d.valueInches + '"')}\${d.verified ? ' ✓' : ''}</span>
    <span class="meta">\${escXml(d.id)}</span>
  </button>\`;
}

function renderInspector() {
  const sel = state.selected;
  if (!sel) {
    inspector.className = 'inspector empty';
    inspector.textContent = 'Click a dimension or finding on the plan.';
    return;
  }
  inspector.className = 'inspector';
  if (sel.kind === 'finding') {
    const f = state.findings.find(x => x.id === sel.id);
    if (!f) { inspector.textContent = 'Missing finding'; return; }
    inspector.innerHTML = \`
      <div class="row"><span class="badge">\${escXml(f.kind)}</span><span class="badge">\${escXml(f.severity)}</span><span class="badge">\${escXml(f.status)}</span></div>
      <p class="hint" style="margin:0.5rem 0">\${escXml(f.message)}</p>
      <div class="row">
        <button type="button" data-act="accept-finding">Accept</button>
        <button type="button" data-act="reject-finding">Reject</button>
      </div>\`;
    inspector.querySelector('[data-act=accept-finding]').onclick = () => {
      f.status = 'accepted';
      state.decisions.push({ findingId: f.id, action: 'accept', at: new Date().toISOString() });
      renderLists(); renderInspector(); renderOverlay();
      toast('Finding accepted');
    };
    inspector.querySelector('[data-act=reject-finding]').onclick = () => {
      f.status = 'rejected';
      state.decisions.push({ findingId: f.id, action: 'reject', at: new Date().toISOString() });
      renderLists(); renderInspector(); renderOverlay();
      toast('Finding rejected');
    };
    return;
  }

  if (sel.kind === 'wall' || sel.kind === 'junction') {
    const struct = sel.side === 'reference' ? state.referenceStructure : state.candidateStructure;
    if (sel.kind === 'wall') {
      const w = (struct?.wallSpans || []).find(x => x.id === sel.id);
      if (!w) { inspector.textContent = 'Missing wall span'; return; }
      inspector.innerHTML = \`
        <div class="row"><span class="badge">structure</span><span class="badge">wall</span>
          <span class="badge \${sel.side === 'reference' ? 'ref' : 'cand'}">\${sel.side}</span></div>
        <div style="margin-top:0.4rem;font-weight:600">\${escXml(w.id)}</div>
        <div class="row"><label>A</label><span>(\${w.a.x.toFixed(0)}, \${w.a.y.toFixed(0)})</span></div>
        <div class="row"><label>B</label><span>(\${w.b.x.toFixed(0)}, \${w.b.y.toFixed(0)})</span></div>
        <p class="hint" style="margin-top:0.6rem">Wall span from structure pass — separate from dimension annotations.</p>\`;
      return;
    }
    const j = (struct?.junctions || []).find(x => x.id === sel.id);
    if (!j) { inspector.textContent = 'Missing junction'; return; }
    inspector.innerHTML = \`
      <div class="row"><span class="badge">structure</span><span class="badge">\${escXml(j.kind || 'junction')}</span>
        <span class="badge \${sel.side === 'reference' ? 'ref' : 'cand'}">\${sel.side}</span></div>
      <div style="margin-top:0.4rem;font-weight:600">\${escXml(j.id)}</div>
      <div class="row"><label>Point</label><span>(\${j.point.x.toFixed(0)}, \${j.point.y.toFixed(0)})</span></div>
      <p class="hint" style="margin-top:0.6rem">Junction from structure pass (not a dim tick).</p>\`;
    return;
  }

  const d = findDim(sel.side, sel.id);
  if (!d) { inspector.textContent = 'Missing dim'; return; }
  const alts = (d.alternateSpans || []).map((_, i) =>
    \`<button type="button" data-alt="\${i}">Use alt \${i + 1}</button>\`
  ).join('');
  inspector.innerHTML = \`
    <div class="row">
      <span class="badge \${sel.side === 'reference' ? 'ref' : 'cand'}">\${sel.side}</span>
      <span class="badge \${d.verified ? 'ok' : ''}">\${d.verified ? 'verified gold' : 'proposed'}</span>
      <code style="font-size:0.75rem;color:var(--muted)">\${escXml(d.id)}</code>
    </div>
    <div class="row">
      <label>Value</label>
      <input class="value-input" type="text" id="insp-value" value="\${escAttr(d.valueText || '')}"/>
      <span style="color:var(--muted);font-size:0.75rem">\${d.valueInches.toFixed(2)}"</span>
    </div>
    <div class="row"><label>Span</label>
      <span data-span-coords style="font-family:ui-monospace;font-size:0.72rem;color:var(--muted)">
        A(\${d.span.a.x.toFixed(0)}, \${d.span.a.y.toFixed(0)}) → B(\${d.span.b.x.toFixed(0)}, \${d.span.b.y.toFixed(0)})
      </span>
    </div>
    <p class="hint" style="margin:0.4rem 0">Drag the white handles on the image to move endpoints. Label stays off the wall.</p>
    <div class="row">\${alts}</div>
    <div class="row">
      <button type="button" class="primary" id="btn-verify">\${d.verified ? 'Re-save gold' : 'Verify → gold'}</button>
      <button type="button" id="btn-unverify" \${d.verified ? '' : 'hidden'}>Unverify</button>
      <button type="button" id="btn-dismiss">Dismiss</button>
    </div>\`;

  const valInput = inspector.querySelector('#insp-value');
  valInput.addEventListener('change', () => {
    d.valueText = valInput.value;
    const m = valInput.value.trim().match(/^(-?\\d+)\\s*'\\s*-?\\s*(\\d+(?:\\.\\d+)?)(?:\\s+(\\d+)\\s*\\/\\s*(\\d+))?\\s*"?$/);
    if (m) {
      let inches = Number(m[2]);
      if (m[3] && m[4]) inches += Number(m[3]) / Number(m[4]);
      d.valueInches = Number(m[1]) * 12 + inches;
    }
    recordCorrect(d.id, { valueText: d.valueText, valueInches: d.valueInches });
    renderOverlay(); renderLists();
  });

  inspector.querySelector('#btn-verify').onclick = async () => {
    d.verified = true;
    state.decisions.push({ dimId: d.id, action: 'accept', at: new Date().toISOString() });
    renderOverlay(); renderLists(); renderInspector();
    try {
      await persistGold('Verified ' + (d.valueText || d.id));
    } catch (_) { /* toast already shown */ }
  };
  const un = inspector.querySelector('#btn-unverify');
  if (un) un.onclick = () => {
    d.verified = false;
    state.decisions.push({ dimId: d.id, action: 'reject', note: 'unverify', at: new Date().toISOString() });
    renderOverlay(); renderLists(); renderInspector();
    toast('Unverified ' + (d.valueText || d.id));
  };
  inspector.querySelector('#btn-dismiss').onclick = () => {
    const list = sel.side === 'reference' ? state.reference : state.candidate;
    const i = list.findIndex(x => x.id === d.id);
    if (i >= 0) list.splice(i, 1);
    state.decisions.push({ dimId: d.id, action: 'reject', at: new Date().toISOString() });
    state.selected = null;
    renderOverlay(); renderLists(); renderInspector();
    toast('Dismissed dimension');
  };
  inspector.querySelectorAll('[data-alt]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-alt'));
      const alt = d.alternateSpans?.[i];
      if (!alt) return;
      const prev = { a: { ...d.span.a }, b: { ...d.span.b } };
      d.span = { a: { ...alt.a }, b: { ...alt.b } };
      d.alternateSpans = [prev, ...d.alternateSpans.filter((_, j) => j !== i)];
      recordCorrect(d.id, { span: d.span });
      renderOverlay(); renderInspector();
    };
  });
}

function applyZoom() {
  // Size the bitmap (and thus the absolutely-positioned SVG overlay) to zoomed
  // CSS pixels. viewBox stays in image pixels, so getBoundingClientRect mapping
  // is always imgW/rect.width == 1/zoom — no CSS transform involved.
  stage.style.transform = '';
  stage.style.transformOrigin = '';
  if (state.imgW) {
    bgEl.style.width = \`\${state.imgW * state.zoom}px\`;
  }
  document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  // Rebuild so handle hit radii stay screen-stable under zoom.
  if (state.imgW && !state.drag) renderOverlay();
}

function fitZoom() {
  const wrap = document.getElementById('stage-wrap');
  if (!state.imgW) return;
  const zx = (wrap.clientWidth - 32) / state.imgW;
  const zy = (wrap.clientHeight - 32) / state.imgH;
  state.zoom = Math.min(1.5, Math.max(0.15, Math.min(zx, zy)));
  applyZoom();
}

bgEl.addEventListener('load', () => {
  state.imgW = bgEl.naturalWidth;
  state.imgH = bgEl.naturalHeight;
  renderOverlay();
  fitZoom();
});

document.querySelectorAll('.toolbar [data-bg]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toolbar [data-bg]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.bg = btn.getAttribute('data-bg');
    bgEl.src = state.bg;
  });
});

document.getElementById('toggle-ref').onclick = (e) => {
  state.showRef = !state.showRef;
  e.currentTarget.classList.toggle('active', state.showRef);
  renderOverlay();
};
document.getElementById('toggle-cand').onclick = (e) => {
  state.showCand = !state.showCand;
  e.currentTarget.classList.toggle('active', state.showCand);
  renderOverlay();
};
document.getElementById('toggle-ref-struct').onclick = (e) => {
  state.showRefStruct = !state.showRefStruct;
  e.currentTarget.classList.toggle('active', state.showRefStruct);
  renderOverlay();
};
document.getElementById('toggle-cand-struct').onclick = (e) => {
  state.showCandStruct = !state.showCandStruct;
  e.currentTarget.classList.toggle('active', state.showCandStruct);
  renderOverlay();
};
document.getElementById('toggle-findings').onclick = (e) => {
  state.showFindings = !state.showFindings;
  e.currentTarget.classList.toggle('active', state.showFindings);
  renderOverlay();
};

document.getElementById('zoom-in').onclick = () => { state.zoom = Math.min(4, state.zoom * 1.2); applyZoom(); };
document.getElementById('zoom-out').onclick = () => { state.zoom = Math.max(0.15, state.zoom / 1.2); applyZoom(); };
document.getElementById('zoom-fit').onclick = fitZoom;

document.getElementById('export-gold').onclick = () => persistGold('Save all gold');

document.getElementById('notes').textContent = state.notes.join('\\n');
detectServer();
renderLists();
renderInspector();
if (bgEl.complete && bgEl.naturalWidth) {
  state.imgW = bgEl.naturalWidth;
  state.imgH = bgEl.naturalHeight;
  renderOverlay();
  fitZoom();
}
</script>
</body>
</html>`;

  writeFileSync(path, html);
  return path;
}
