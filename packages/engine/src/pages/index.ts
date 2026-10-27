export { buildPage } from "./build.js";
export type { BuildPageOptions, BuildPageResult, PageSuggestion, PrintFigure } from "./types.js";
export { mergeBlocks, stripMarkers, readSidecar, writeSidecar, sidecarPath } from "./markers.js";
export type { GeneratedBlock, MergeResult } from "./markers.js";
export { annotateFrame, renderPrintFrame } from "./annotate.js";
export { planStepFigures, focusCrop, FOCUS_CROP, type StepFigurePlan } from "./focus.js";
export {
  buildFrontmatterBlock,
  buildHeaderBlock,
  buildBeforeYouStartBlock,
  buildStepsHeadingBlock,
  buildChapterBlock,
  buildStepBlock,
  buildLastCheckedBlock,
  chaptersOf,
  screenshotFile,
} from "./content.js";
export type { StepStatus, PageFrontmatter, FrontmatterLinks } from "./content.js";
export { readFrontmatter, bodyOf, setFrontmatterFields, frontmatterBlock, type FrontmatterValue } from "./frontmatter.js";
