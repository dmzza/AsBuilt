# Plan fidelity evaluator

Tool-agnostic scorer: how well does plan image B match plan image A?

Works for **hand drawing ↔ hand drawing** and **hand drawing ↔ AsBuilt render** (or any other tool’s PNG). The scorer never sees ABL names — AsBuilt only supplies a candidate image via a thin render adapter.

## Quick start

```bash
# Seed the demo case (demo .abl → reference + candidate PNGs)
npx vite-node scripts/seed-eval-demo.ts

# Score (uses gold dims if present; otherwise vision if API key set)
export ANTHROPIC_API_KEY=…   # or OPENAI_API_KEY
# optional override: EVAL_VISION_MODEL=claude-sonnet-5  (this is already the default)
npm run eval -- eval/cases/demo_dining

# Interactive review (local server — Verify → gold saves into the case)
npm run eval:review -- eval/cases/demo_dining
```

In the review UI:

1. Click a dimension **on the plan image** (span or off-wall label chip).
2. Drag endpoint handles to fix the measured span.
3. **Verify → gold** — persists into `gold/` (toast confirms when the review server is running).
4. **Save all gold** writes every verified dim to the case.
5. Re-run `npm run eval` to reuse gold.

## Case layout

```
eval/cases/<id>/
  reference.png
  candidate.png              # optional if meta.asbuiltProject is set
  project/                   # optional .abl tree
  meta.json
  gold/reference.dims.json   # after human review
  gold/candidate.dims.json
  reviews/<run>/review.html  # overlays + scorecard
  reviews/latest/
```

## Design notes

- **Spare no expense** on vision: frontier models, multi-pass + tiled zooms, confirmation crops (`ANTHROPIC_API_KEY` preferred).
- Gold is **image-anchored** `{ valueInches, labelBBox, span: { a, b } }` — never ABL entity IDs.
- Findings (layout, dim value, dim span) are provisional until accepted/rejected in review.

## API

```ts
import { scorePlanPair } from "./eval/src";

const result = await scorePlanPair({
  reference: refPngBuffer,
  candidate: candPngBuffer,
  referenceGold, // optional
  artifactDir: "./out",
});
```
