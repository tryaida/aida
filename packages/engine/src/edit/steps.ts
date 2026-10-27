// Walkthrough step edit actions: setStepField, setStepActions, reorderSteps, removeStep. One
// small set shared by the Studio, the CLI (`aida edit`) and, later, the generator MCP server.
import * as YAML from "yaml";
import { z } from "zod";
import { appendHistory, registerRevert } from "./history.js";
import { findHelpRoot } from "./help-root.js";
import { isLockedAny } from "./locks.js";
import {
  findStepIndex,
  getStepsSeq,
  readYamlDocument,
  validateDocOrThrow,
  walkthroughId,
  writeYamlDocument,
} from "./yaml-doc.js";
import { ActionSchema } from "../walkthrough/action.js";
import type { Action } from "../walkthrough/action.js";
import type { Camera } from "../walkthrough/types.js";
import { EditLockedError, EditValidationError } from "./types.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";

// `do`/`check` are the plain-words locator fields `aida-repair` fixes (skills/aida-repair/
// SKILL.md): a step's `do: click "X" button` or `check: text "Y" is visible`. Setting either
// here writes a single plain-words string (replacing the field's current string/array value) —
// `validateDocOrThrow` below parses it with the walkthrough parser (`parseDoString`/`parseCheck`
// via `rawStepToStep`), so a locator typo is rejected before anything is written, the same way a
// bad schema value already is for the other fields.
export type StepField = "say" | "caption" | "page_text" | "title" | "hold" | "do" | "check";

function stepLockKeys(wtId: string, stepId: string, field?: string): string[] {
  const keys = [`walkthrough:${wtId}`, `step:${wtId}:${stepId}`];
  if (field) keys.push(`step:${wtId}:${stepId}:${field}`);
  return keys;
}

function record(helpRoot: string, file: string, opts: EditOptions, action: string, target: string, before: unknown, after: unknown): HistoryEntry {
  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    by: opts.by ?? "agent",
    action,
    target,
    before,
    after,
    file,
  };
  if (opts.record !== false) appendHistory(helpRoot, entry);
  return entry;
}

/** Sets one field (say/caption/page_text/title/hold) on a step, identified by its `id`. Rejects
 * (without writing) if the result fails schema validation, or if an agent edit targets a locked
 * step/walkthrough. */
export function setStepField(
  walkthroughFile: string,
  stepId: string,
  field: StepField,
  value: string | number,
  opts: EditOptions = {},
): EditResult {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);
  const stepsSeq = getStepsSeq(doc);
  const stepNode = stepsSeq.items[idx];
  if (!YAML.isMap(stepNode)) throw new Error(`step "${stepId}" is not a mapping`);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, stepLockKeys(wtId, stepId, field));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const before = stepNode.get(field) as string | number | undefined;
  // `do`/`check` and `actions:` are mutually exclusive (the schema rejects a step having both —
  // see walkthrough/schema.ts): a step's old `actions:` list used to keep running even after an
  // agent repaired its `do`/`check`, because rawStepToStep concatenated both. Setting `do`/
  // `check` here now replaces the step's locator, so drop any existing `actions:` on it first.
  if ((field === "do" || field === "check") && stepNode.has("actions")) {
    doc.deleteIn(["steps", idx, "actions"]);
  }
  doc.setIn(["steps", idx, field], value);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.${field}`;
  record(helpRoot, walkthroughFile, opts, "setStepField", target, before, value);
  return { target, before, after: value };
}

registerRevert("setStepField", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId, field] = rest.split(".");
  setStepField(entry.file, stepId, field as StepField, entry.before as string | number, { by: entry.by, record: false });
});

/** Reorders a walkthrough's steps to match `newOrder` (an array of every existing step id, in
 * the new order). Rejects if `newOrder` doesn't contain exactly the same ids as the walkthrough. */
export function reorderSteps(walkthroughFile: string, newOrder: string[], opts: EditOptions = {}): EditResult<string[]> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const stepsSeq = getStepsSeq(doc);

  const currentIds = stepsSeq.items.map((item) => (YAML.isMap(item) ? (item.get("id") as string | undefined) : undefined));
  if (currentIds.some((id) => id === undefined)) {
    throw new Error("reorderSteps requires every step to have an id");
  }
  const before = currentIds as string[];
  const sortedBefore = [...before].sort();
  const sortedAfter = [...newOrder].sort();
  if (JSON.stringify(sortedBefore) !== JSON.stringify(sortedAfter)) {
    throw new Error("newOrder must contain exactly the walkthrough's current step ids");
  }

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, [`walkthrough:${wtId}`]);
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const byId = new Map(before.map((id, i) => [id, stepsSeq.items[i]]));
  stepsSeq.items = newOrder.map((id) => byId.get(id)!);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#steps`;
  record(helpRoot, walkthroughFile, opts, "reorderSteps", target, before, newOrder);
  return { target, before, after: newOrder };
}

registerRevert("reorderSteps", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  reorderSteps(entry.file, entry.before as string[], { by: entry.by, record: false });
});

export interface RemovedStep {
  index: number;
  step: unknown;
}

/** Removes a step, identified by its `id`. Rejects if it's the walkthrough's last step (the
 * schema requires at least one), or if an agent edit targets a locked step/walkthrough. */
export function removeStep(walkthroughFile: string, stepId: string, opts: EditOptions = {}): EditResult<RemovedStep | undefined> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);
  const stepsSeq = getStepsSeq(doc);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, stepLockKeys(wtId, stepId));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const removedNode = stepsSeq.items[idx];
  const before: RemovedStep = { index: idx, step: YAML.isMap(removedNode) ? removedNode.toJSON() : removedNode };
  stepsSeq.items = stepsSeq.items.filter((_, i) => i !== idx);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}`;
  record(helpRoot, walkthroughFile, opts, "removeStep", target, before, undefined);
  return { target, before, after: undefined };
}

registerRevert("removeStep", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const before = entry.before as RemovedStep;
  const doc = readYamlDocument(entry.file);
  const stepsSeq = getStepsSeq(doc);
  const node = doc.createNode(before.step);
  stepsSeq.items.splice(before.index, 0, node);
  validateDocOrThrow(doc, entry.file);
  writeYamlDocument(entry.file, doc);
});

const ActionsArraySchema = z.array(ActionSchema);

/** Replaces a step's `actions:` list outright with `actions` — a structured alternative to
 * `setStepField`'s plain-words `do`/`check` for a repair an agent can't express in plain words
 * (e.g. a target needing `within`/`exact`, or a `waitFor` with `snapshot`). `actions` is
 * validated against the walkthrough's own `ActionSchema` before it's accepted (rejects, without
 * writing, on the first invalid entry), then the whole document is validated again the same way
 * every other edit action is. `do`/`check` and `actions:` are mutually exclusive (the schema
 * rejects a step with both — walkthrough/schema.ts), so this also clears any `do:`/`check:`
 * plain-words fields already on the step: previously it left them in place, and rawStepToStep
 * concatenated do + check + actions, so a step's old do/check kept running alongside the new
 * actions. */
export function setStepActions(
  walkthroughFile: string,
  stepId: string,
  actions: unknown,
  opts: EditOptions = {},
): EditResult<Action[]> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);
  const stepsSeq = getStepsSeq(doc);
  const stepNode = stepsSeq.items[idx];
  if (!YAML.isMap(stepNode)) throw new Error(`step "${stepId}" is not a mapping`);

  const parsed = ActionsArraySchema.safeParse(actions);
  if (!parsed.success) {
    throw new EditValidationError(`setStepActions rejected — ${parsed.error.message}`);
  }

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, stepLockKeys(wtId, stepId, "actions"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const before = (stepNode.get("actions") as Action[] | undefined) ?? [];
  // Mirror of the setStepField fix above: a structured `actions:` list replaces a step's
  // locator outright, so drop any plain-words `do`/`check` still on the step — otherwise the
  // schema rejects the step (do/check and actions: are mutually exclusive) and, before that
  // check existed, the stale do/check kept running alongside the new actions.
  if (stepNode.has("do")) doc.deleteIn(["steps", idx, "do"]);
  if (stepNode.has("check")) doc.deleteIn(["steps", idx, "check"]);
  doc.setIn(["steps", idx, "actions"], parsed.data);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.actions`;
  record(helpRoot, walkthroughFile, opts, "setStepActions", target, before, parsed.data);
  return { target, before, after: parsed.data };
}

registerRevert("setStepActions", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".");
  setStepActions(entry.file, stepId, entry.before as Action[], { by: entry.by, record: false });
});

export interface InsertStepOptions {
  /** Insert immediately after this step id. Exactly one of after/before/atStart is required. */
  after?: string;
  /** Insert immediately before this step id. */
  before?: string;
  /** Insert as the new first step. */
  atStart?: boolean;
  /** The new step's id — must not already exist in the walkthrough. */
  id: string;
  do?: string;
  say?: string;
  caption?: string;
  pageText?: string;
  title?: string;
  /** Groups the step into a video chapter / page section — see Step.chapter. */
  chapter?: string;
  camera?: Camera;
}

/** Inserts a new step — used by `aida-repair` to add a missing step (e.g. an unscripted
 * required field) without rewriting the whole file by hand. Exactly one of `after`/`before`/
 * `atStart` picks the position; `id` must be new. Rejects (without writing) on an unknown
 * anchor id, a duplicate id, or a `do` the walkthrough parser can't parse. */
export function insertStep(
  walkthroughFile: string,
  opts: InsertStepOptions,
  editOpts: EditOptions = {},
): EditResult<Record<string, unknown> | undefined> {
  const by = editOpts.by ?? "agent";
  const positions = [opts.after !== undefined, opts.before !== undefined, Boolean(opts.atStart)].filter(Boolean).length;
  if (positions !== 1) {
    throw new Error("insertStep requires exactly one of --after, --before, --at-start");
  }

  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const stepsSeq = getStepsSeq(doc);

  const existingIds = stepsSeq.items.map((item) => (YAML.isMap(item) ? (item.get("id") as string | undefined) : undefined));
  if (existingIds.includes(opts.id)) {
    throw new Error(`insertStep: a step with id "${opts.id}" already exists`);
  }

  let insertIndex: number;
  if (opts.atStart) {
    insertIndex = 0;
  } else if (opts.after !== undefined) {
    insertIndex = findStepIndex(doc, opts.after) + 1;
  } else {
    insertIndex = findStepIndex(doc, opts.before!);
  }

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, [`walkthrough:${wtId}`]);
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const newStep: Record<string, unknown> = { id: opts.id };
  if (opts.chapter !== undefined) newStep.chapter = opts.chapter;
  if (opts.title !== undefined) newStep.title = opts.title;
  if (opts.do !== undefined) newStep.do = opts.do;
  if (opts.say !== undefined) newStep.say = opts.say;
  if (opts.caption !== undefined) newStep.caption = opts.caption;
  if (opts.pageText !== undefined) newStep.page_text = opts.pageText;
  if (opts.camera !== undefined) newStep.camera = opts.camera;

  const node = doc.createNode(newStep);
  stepsSeq.items.splice(insertIndex, 0, node);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${opts.id}`;
  record(helpRoot, walkthroughFile, editOpts, "insertStep", target, undefined, newStep);
  return { target, before: undefined, after: newStep };
}

registerRevert("insertStep", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, stepId] = entry.target.split("#");
  removeStep(entry.file, stepId, { by: entry.by, record: false });
});
