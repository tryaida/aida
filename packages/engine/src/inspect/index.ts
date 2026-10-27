export { scanPage } from "./snapshot.js";
export { clickToOpen, checkToReveal, selectOption, InspectClickRefusedError } from "./click.js";
export { redactPiiText } from "./redact.js";
export {
  capSelectOptions,
  markRequired,
  annotateFieldHints,
  annotateDuplicates,
  redactLines,
  capLines,
  normalizeName,
  formatSnapshot,
  INTERACTIVE_ROLE_RE,
} from "./format.js";
export type { FieldHint, DuplicateHint } from "./format.js";
export type { InspectResult, InspectScanOptions, ClickOutcome } from "./types.js";
