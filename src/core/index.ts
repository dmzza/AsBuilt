// The AsBuilt core: a declarative constraint language for partially-specified
// architectural models with layered (branching) semantics.
//
// Pipeline: parse layer files -> merge chain (shadowing, tombstones, template
// expansion, reference checks) -> solve (weighted Gauss-Newton) -> views.
// Edits flow the other way: GUI intents become deterministic text edits to the
// current layer file (see editkit).

export * from "./units";
export * from "./ast";
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
  derivedGrade,
  wallLengthGrade,
  allWallGrades,
  weakest,
  type Grade,
  type ParamView,
  type Pipeline,
  type WallView,
} from "./model";
export {
  loadProject,
  layerMap,
  applyEdits,
  proposeMove,
  proposeSetParam,
  proposeAddWall,
  proposeDelete,
  proposeMeasure,
  proposeEditMeas,
  createConcept,
  genName,
  type AddWallProposal,
  type MeasureTarget,
  type MoveProposal,
  type Project,
  type TextEdit,
  type WallEndpoint,
} from "./editkit";
