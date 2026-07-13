# Eval review preview fixtures

Static scorecard + PNG bundles for Cloudflare Pages so PR previews can open
the interactive review UI without a Node server.

- `demo_dining/` — committed fixture (scorecard + overlays)
- `review.html` is **generated** at build time by `npm run eval:prepare-preview`
  (so the deploy always uses the current branch's `eval/src/report.ts`)

Refresh the fixture after a local score:

```bash
npm run eval -- eval/cases/demo_dining
cp eval/cases/demo_dining/reviews/latest/{scorecard.json,*.png} \
  public/eval-review/demo_dining/
# omit review.html — prepare-eval-preview regenerates it
```

Preview URL after deploy: `/eval-review/demo_dining/review.html`
