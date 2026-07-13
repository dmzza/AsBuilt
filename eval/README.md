# Plan fidelity evaluator

Tool-agnostic scorer: how well does plan image B match plan image A?

Works for **hand drawing ↔ hand drawing** and **hand drawing ↔ AsBuilt render** (or any other tool’s PNG). The scorer never sees ABL names — AsBuilt only supplies a candidate image via a thin render adapter.

## Quick start

```bash
npm run eval:ui
```

Opens a local UI: **New eval** → drop your drawing + candidate (image or `.abl` project) → scores and opens review.

Or CLI:

```bash
npm run eval -- eval/cases/demo_dining
npm run eval:review -- eval/cases/demo_dining
```

## Pages preview

PR deploys include a static demo review so you can exercise the interactive UI
without running a local server:

`https://<preview>.asbuilt.pages.dev/eval-review/demo_dining/review.html`

(also linked from the Cloudflare Pages PR comment). The HTML is regenerated on
each `build:pages` from `public/eval-review/demo_dining/scorecard.json`, so
changes to `eval/src/report.ts` show up on the next deploy. Gold save is
download-only in this mode (no Node API on Pages).

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
