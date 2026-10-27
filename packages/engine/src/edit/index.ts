// Edit module public API: the shared edit actions used by the Studio, the CLI
// (`aida edit`/`aida undo`/`aida catch-up`) and, later, the generator MCP server.
export * from "./types.js";
export { findHelpRoot, aidaDir } from "./help-root.js";
export {
  setStepField,
  setStepActions,
  reorderSteps,
  removeStep,
  insertStep,
  type StepField,
  type RemovedStep,
  type InsertStepOptions,
} from "./steps.js";
export {
  addCallout,
  updateCallout,
  removeCallout,
  reorderCallouts,
  addBlur,
  updateBlur,
  removeBlur,
  type OverlayPatch,
} from "./callouts.js";
export {
  addPath,
  removePath,
  setPathField,
  setPathStepField,
  setPathStepActions,
  type PathField,
  type RemovedPath,
} from "./paths.js";
export { setPageBlock } from "./page.js";
export { setData } from "./data.js";
export { lock, unlock, isLocked, isLockedAny, readLocks } from "./locks.js";
export {
  appendHistory,
  readHistory,
  undo,
  catchUp,
  historyPath,
  readLastCatchUpAt,
  writeLastCatchUpAt,
  type UndoResult,
} from "./history.js";
