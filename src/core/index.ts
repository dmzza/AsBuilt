// The AsBuilt core: a declarative constraint language for partially-specified
// architectural models with layered (branching) semantics.
//
// Pipeline: parse layer files -> merge chain (shadowing, tombstones, template
// expansion, reference checks) -> solve (weighted Gauss-Newton) -> views.
// Edits flow the other way: GUI intents become deterministic text edits to the
// current layer file (see editkit).

export * from "./units";
export * from "./ast";
export {
  faceSign,
  isCenterlineRef,
  normalizeFaceRef,
  parseFaceRefText,
  formatFaceRef,
  wallBetween,
  crossingWallType,
  faceLengthsOfWall,
  faceMeasureEndpoints,
} from "./faces";
export { parseLayerFile, parseExpr } from "./parser";
export { printLayerFile, printStmt, printExpr } from "./printer";
export {
  resolve,
  effectiveParams,
  evalExpr,
  exprRefs,
  type Diagnostic,
  type EffStmt,
  type EffParam,
  type Resolved,
} from "./merge";
export {
  buildSystem,
  solve,
  junctionPos,
  paramValue,
  thicknessValue,
  CONTRADICTION_TOL,
  type BuildOptions,
  type Contradiction,
  type Solution,
  type System,
} from "./solve";
export {
  resolveAndSolve,
  perturbParam,
  perturbTarget,
  defaultAnchors,
  wallView,
  paramView,
  allParams,
  allWallTypes,
  defaultMeasureRef,
  derivedGrade,
  wallLengthGrade,
  allWallGrades,
  openingViews,
  fixtureViews,
  levelViews,
  levelOfKey,
  previewDiff,
  weakest,
  type FixtureView,
  type LevelView,
  type PreviewDiff,
  type Grade,
  type OpeningView,
  type ParamView,
  type Pipeline,
  type WallTypeView,
  type WallView,
} from "./model";
export {
  loadProject,
  layerMap,
  applyEdits,
  proposeMove,
  proposeMoveWall,
  proposeSetParam,
  proposeAddWall,
  proposeSplitWall,
  proposeDelete,
  proposeMeasure,
  proposeEditMeas,
  proposeAddOpening,
  proposeSetOpening,
  proposeSetOpeningOffset,
  proposeSetWallType,
  proposeAddFixture,
  proposeSetFixture,
  proposeReparent,
  proposeResolveMasked,
  proposeDropOrphan,
  createConcept,
  genName,
  OPENING_DEFAULTS,
  type AddWallProposal,
  type SplitWallProposal,
  type MeasureTarget,
  type MoveOpts,
  type MoveProposal,
  type Project,
  type TextEdit,
  type WallEndpoint,
} from "./editkit";
