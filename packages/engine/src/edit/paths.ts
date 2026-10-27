// Walkthrough path edit actions (decision 34): addPath, removePath, setPathField,
// setPathStepField, setPathStepActions. The same shape as the step actions in steps.ts: read the
// YAML document, check locks for an agent edit, change one node, validate the whole walkthrough
// (joins must name a main step, path ids unique, one persona), write, and record history with a
// registered revert so `aida undo` works.
//
// Lock keys, broader to narrower:
//   walkthrough:<id>
//   path:<id>:<pathId>                      the whole path
//   path:<id>:<pathId>:<field>              title, when, note, joins, page
//   path:<id>:<pathId>:step:<stepId>        one opening step
//   path:<id>:<pathId>:step:<stepId>:<field>
import * as YAML from "yaml";
import { z } from "zod";
import { appendHistory, registerRevert } from "./history.js";
import { findHelpRoot } from "./help-root.js";
import { isLockedAny } from "./locks.js";
import { readYamlDocument, validateDocOrThrow, walkthroughId, writeYamlDocument } from "./yaml-doc.js";
import { ActionSchema } from "../walkthrough/action.js";
import { EditLockedError, EditValidationError } from "./types.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";
import type { StepField } from "./steps.js";

/** Path fields `setPathField` changes; `page` is the path's `start.page`. */
export type PathField = "title" | "when" | "note" | "joins" | "page";
const PATH_FIELDS: readonly PathField[] = ["title", "when", "note", "joins", "page"];

function record(helpRoot: string, file: string, opts: EditOptions, action: string, target: string, before: unknown, after: unknown): HistoryEntry {
  const entry: HistoryEntry = { at: new Date().toISOString(), by: opts.by ?? "agent", action, target, before, after, file };
  if (opts.record !== false) appendHistory(helpRoot, entry);
  return entry;
}

function checkLocks(helpRoot: string, opts: EditOptions, keys: string[]): void {
  if ((opts.by ?? "agent") !== "agent") return;
  const lockedKey = isLockedAny(helpRoot, keys);
  if (lockedKey) throw new EditLockedError(lockedKey);
}

function pathLockKeys(wtId: string, pathId: string, ...rest: string[]): string[] {
  const keys = [`walkthrough:${wtId}`, `path:${wtId}:${pathId}`];
  let key = `path:${wtId}:${pathId}`;
  for (const part of rest) {
    key = `${key}:${part}`;
    keys.push(key);
  }
  return keys;
}

function pathsSeq(doc: YAML.Document.Parsed): YAML.YAMLSeq | undefined {
  const node = doc.get("paths", true);
  return YAML.isSeq(node) ? node : undefined;
}

/** A path's index in the `paths:` list by id. Throws when there's no such path. */
function findPathIndex(doc: YAML.Document.Parsed, pathId: string): number {
  const seq = pathsSeq(doc);
  const index = seq ? seq.items.findIndex((item) => YAML.isMap(item) && item.get("id") === pathId) : -1;
  if (index === -1) {
    const ids = seq?.items.map((item) => (YAML.isMap(item) ? item.get("id") : undefined)).filter(Boolean) ?? [];
    throw new Error(`no path with id "${pathId}"${ids.length > 0 ? ` (paths: ${ids.join(", ")})` : " (the walkthrough has no paths)"}`);
  }
  return index;
}

/** A path step's index in that path's `steps:` list by id. */
function findPathStepIndex(doc: YAML.Document.Parsed, pathIndex: number, pathId: string, stepId: string): number {
  const steps = doc.getIn(["paths", pathIndex, "steps"], true);
  const index = YAML.isSeq(steps) ? steps.items.findIndex((item) => YAML.isMap(item) && item.get("id") === stepId) : -1;
  if (index === -1) throw new Error(`path "${pathId}" has no step with id "${stepId}"`);
  return index;
}

/** Where a step lives in the YAML and which lock keys guard it. */
export interface StepRef {
  /** e.g. `["steps", 3]` or `["paths", 0, "steps", 1]`. */
  yamlPath: (string | number)[];
  /** Lock keys, broader to narrower, for an edit to `field` (or the whole step) of this step. */
  lockKeys: (field?: string) => string[];
}

/**
 * A step by reference: a main step id, or `<pathId>/<stepId>` for a path's opening step (callout
 * and blur actions take either). A main step whose id is exactly `ref` wins.
 */
export function resolveStepRef(doc: YAML.Document.Parsed, wtId: string, ref: string): StepRef {
  const steps = doc.get("steps", true);
  const mainIndex = YAML.isSeq(steps) ? steps.items.findIndex((item) => YAML.isMap(item) && item.get("id") === ref) : -1;
  if (mainIndex !== -1) {
    return {
      yamlPath: ["steps", mainIndex],
      lockKeys: (field) => [`walkthrough:${wtId}`, `step:${wtId}:${ref}`, ...(field ? [`step:${wtId}:${ref}:${field}`] : [])],
    };
  }
  const slash = ref.indexOf("/");
  if (slash === -1) throw new Error(`no step with id "${ref}" (a path's step is "<pathId>/<stepId>")`);
  const pathId = ref.slice(0, slash);
  const stepId = ref.slice(slash + 1);
  const pathIndex = findPathIndex(doc, pathId);
  const stepIndex = findPathStepIndex(doc, pathIndex, pathId, stepId);
  return {
    yamlPath: ["paths", pathIndex, "steps", stepIndex],
    lockKeys: (field) => pathLockKeys(wtId, pathId, "step", stepId, ...(field ? [field] : [])),
  };
}

const PathInputSchema = z.object({ id: z.string() }).passthrough();

/** Adds a path (an object with at least `id`, `title`, `when`, `start.page`, `steps` and
 * `joins`), at the end of `paths:` or at `index`. The whole walkthrough is validated first. */
export function addPath(walkthroughFile: string, path: unknown, opts: EditOptions & { index?: number } = {}): EditResult {
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const parsed = PathInputSchema.safeParse(path);
  if (!parsed.success) throw new EditValidationError("addPath rejected — a path is an object with an `id`");
  const pathId = parsed.data.id;
  checkLocks(helpRoot, opts, [`walkthrough:${wtId}`]);

  const seq = pathsSeq(doc);
  if (seq?.items.some((item) => YAML.isMap(item) && item.get("id") === pathId)) {
    throw new Error(`addPath: a path with id "${pathId}" already exists`);
  }
  const node = doc.createNode(parsed.data);
  if (seq) {
    const index = opts.index === undefined ? seq.items.length : Math.max(0, Math.min(opts.index, seq.items.length));
    seq.items.splice(index, 0, node);
  } else {
    doc.set("paths", doc.createNode([parsed.data]));
  }
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#paths.${pathId}`;
  record(helpRoot, walkthroughFile, opts, "addPath", target, undefined, parsed.data);
  return { target, before: undefined, after: parsed.data };
}

registerRevert("addPath", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const pathId = entry.target.split("#paths.")[1];
  removePath(entry.file, pathId, { by: entry.by, record: false });
});

export interface RemovedPath {
  index: number;
  path: unknown;
}

/** Removes a path by id. An empty `paths:` list is removed with it. */
export function removePath(walkthroughFile: string, pathId: string, opts: EditOptions = {}): EditResult<RemovedPath | undefined> {
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const index = findPathIndex(doc, pathId);
  checkLocks(helpRoot, opts, pathLockKeys(wtId, pathId));

  const seq = pathsSeq(doc)!;
  const node = seq.items[index];
  const before: RemovedPath = { index, path: YAML.isMap(node) ? node.toJSON() : node };
  seq.items.splice(index, 1);
  if (seq.items.length === 0) doc.delete("paths");
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#paths.${pathId}`;
  record(helpRoot, walkthroughFile, opts, "removePath", target, before, undefined);
  return { target, before, after: undefined };
}

registerRevert("removePath", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const before = entry.before as RemovedPath;
  addPath(entry.file, before.path, { by: entry.by, record: false, index: before.index });
});

/** Sets one field of a path: `title`, `when`, `note`, `joins` (a main step id) or `page` (its
 * `start.page`). An empty `note` removes it. */
export function setPathField(walkthroughFile: string, pathId: string, field: PathField, value: string, opts: EditOptions = {}): EditResult {
  if (!PATH_FIELDS.includes(field)) throw new Error(`setPathField: unknown field "${field}" (expected one of: ${PATH_FIELDS.join(", ")})`);
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const index = findPathIndex(doc, pathId);
  checkLocks(helpRoot, opts, pathLockKeys(wtId, pathId, field));

  const yamlPath = field === "page" ? ["paths", index, "start", "page"] : ["paths", index, field];
  const before = doc.getIn(yamlPath) as string | undefined;
  if (field === "note" && value === "") doc.deleteIn(yamlPath);
  else doc.setIn(yamlPath, value);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#paths.${pathId}.${field}`;
  const after = field === "note" && value === "" ? undefined : value;
  record(helpRoot, walkthroughFile, opts, "setPathField", target, before, after);
  return { target, before, after };
}

registerRevert("setPathField", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [pathId, field] = entry.target.split("#paths.")[1].split(".");
  setPathField(entry.file, pathId, field as PathField, (entry.before as string | undefined) ?? "", { by: entry.by, record: false });
});

/** Puts a path step back exactly as it was (the snapshot an edit recorded), so undo restores
 * fields the edit removed too (`do`/`check` replaced by `actions:`, or the other way round). */
function restorePathStep(file: string, target: string, snapshot: unknown): void {
  const [pathId, , stepId] = target.split("#paths.")[1].split(".");
  const doc = readYamlDocument(file);
  const pathIndex = findPathIndex(doc, pathId);
  const stepIndex = findPathStepIndex(doc, pathIndex, pathId, stepId);
  doc.setIn(["paths", pathIndex, "steps", stepIndex], doc.createNode(snapshot));
  validateDocOrThrow(doc, file);
  writeYamlDocument(file, doc);
}

function stepSnapshot(doc: YAML.Document.Parsed, stepPath: (string | number)[]): Record<string, unknown> {
  const node = doc.getIn(stepPath, true);
  return (YAML.isMap(node) ? node.toJSON() : {}) as Record<string, unknown>;
}

/** Sets one field (say/caption/page_text/title/hold/do/check) on a path's opening step, the way
 * `setStepField` does on a main step: `do`/`check` replace the step's `actions:`. History keeps
 * the whole step before and after, so undo puts back anything the edit removed. */
export function setPathStepField(
  walkthroughFile: string,
  pathId: string,
  stepId: string,
  field: StepField,
  value: string | number,
  opts: EditOptions = {},
): EditResult {
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const pathIndex = findPathIndex(doc, pathId);
  const stepIndex = findPathStepIndex(doc, pathIndex, pathId, stepId);
  checkLocks(helpRoot, opts, pathLockKeys(wtId, pathId, "step", stepId, field));

  const stepPath = ["paths", pathIndex, "steps", stepIndex];
  const before = stepSnapshot(doc, stepPath);
  if ((field === "do" || field === "check") && doc.hasIn([...stepPath, "actions"])) doc.deleteIn([...stepPath, "actions"]);
  doc.setIn([...stepPath, field], value);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#paths.${pathId}.steps.${stepId}.${field}`;
  const after = stepSnapshot(doc, stepPath);
  record(helpRoot, walkthroughFile, opts, "setPathStepField", target, before, after);
  return { target, before, after };
}

registerRevert("setPathStepField", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  restorePathStep(entry.file, entry.target, entry.before);
});

const ActionsArraySchema = z.array(ActionSchema);

/** Replaces a path step's `actions:` list (clearing its `do`/`check`), as `setStepActions` does.
 * History keeps the whole step, so undo brings its `do`/`check` back. */
export function setPathStepActions(
  walkthroughFile: string,
  pathId: string,
  stepId: string,
  actions: unknown,
  opts: EditOptions = {},
): EditResult<Record<string, unknown>> {
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const pathIndex = findPathIndex(doc, pathId);
  const stepIndex = findPathStepIndex(doc, pathIndex, pathId, stepId);
  const parsed = ActionsArraySchema.safeParse(actions);
  if (!parsed.success) throw new EditValidationError(`setPathStepActions rejected — ${parsed.error.message}`);
  checkLocks(helpRoot, opts, pathLockKeys(wtId, pathId, "step", stepId, "actions"));

  const stepPath = ["paths", pathIndex, "steps", stepIndex];
  const before = stepSnapshot(doc, stepPath);
  if (doc.hasIn([...stepPath, "do"])) doc.deleteIn([...stepPath, "do"]);
  if (doc.hasIn([...stepPath, "check"])) doc.deleteIn([...stepPath, "check"]);
  doc.setIn([...stepPath, "actions"], parsed.data);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#paths.${pathId}.steps.${stepId}.actions`;
  const after = stepSnapshot(doc, stepPath);
  record(helpRoot, walkthroughFile, opts, "setPathStepActions", target, before, after);
  return { target, before, after };
}

registerRevert("setPathStepActions", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  restorePathStep(entry.file, entry.target, entry.before);
});
