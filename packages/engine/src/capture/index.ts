export { runCapture } from "./runner.js";
export type { CaptureOptions, CaptureRunResult, RunInfo } from "./runner.js";
export { locate, boxOf, center } from "./locate.js";
export { paint, settle, smoothScrollTo } from "./settle.js";
export { applyMasks, applyPersonalDataMask, clearMasks, maskTargets } from "./mask.js";
export type { MaskOptions } from "./mask.js";
export { assertWritesAllowed, assertLocalDatabase, isLocalBaseUrl } from "./write-guard.js";
export { buildFailureReport, recheckAfterReload, runLevelFailure, formatFailureLines, failureEvidence, appProblems, appProblemFailure, thirdPartyWarning } from "./failure-report.js";
export { classifyFailure, classifyErrorMessage, isSignInPath, StepWatch } from "./diagnose.js";
export type { ClassifyInput, Classification } from "./diagnose.js";
export { ImpactTracker, graphqlOperation, isGraphqlRequest, serverActionSaved } from "./impact.js";
export { stableHash } from "./stable-hash.js";
export { capturePaths, comparePathRuns, diffPaths, markPathsNotCaptured, pathClipSources, pathsPassed, prunePathDirs, recordPathDiffs } from "./paths.js";
export type { CapturePathsOptions, CapturePathsResult, PathCaptureSummary, PathClipSource } from "./paths.js";
export { actionIds, comparePathWrites, countFrames, endChecks, pathCaptureDir, readPathCaptures, routePattern, writeKey, writeKeys } from "./path-files.js";
export type { EndChecks, PathCapture } from "./path-files.js";
export { diffPngBuffers, stabilizeFrames, snapshotPrevFrames, finishStabilization, withFrameStabilization } from "./frame-diff.js";
export type { FrameDiffResult, StabilizeOptions, StabilizeResult } from "./frame-diff.js";
export type {
  Box,
  Point,
  Transition,
  CaptureEvent,
  ImpactRequest,
  StepImpact,
  CheckResult,
  ManifestStep,
  CaptureManifest,
  ProblemEntry,
  StepResult,
  DatabaseCheckResult,
  ValidationResult,
  FailureReport,
  FailureCategory,
  FailureChanges,
  FailureRequest,
  FailureActionRef,
  CaptureSummary,
  FrameDiffSummary,
  PathDiff,
  PathEndChecks,
  PathCheckResult,
} from "./types.js";
export { gotoReady, waitForPageReady, waitForNetworkQuiet, NETWORK_IDLE_CAP_MS } from "./page-ready.js";
