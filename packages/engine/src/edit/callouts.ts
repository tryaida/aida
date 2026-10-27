// Callout/blur edit actions (M22): addCallout, updateCallout, removeCallout, reorderCallouts,
// addBlur, updateBlur, removeBlur. Same small shared-action shape as steps.ts — Studio buttons,
// the CLI (`aida edit`) and the generator MCP server all go through these, so a callout added
// by clicking in the Studio and one added by `aida edit addCallout` end up byte-identical.
import * as YAML from "yaml";
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
import type { BlurBox, Box, Callout, Target } from "../walkthrough/types.js";
import { EditLockedError } from "./types.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";

type OverlayField = "callouts" | "blur";

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

function lockKeys(wtId: string, stepId: string, field: OverlayField): string[] {
  return [`walkthrough:${wtId}`, `step:${wtId}:${stepId}`, `step:${wtId}:${stepId}:${field}`];
}

function getOverlaySeq(doc: YAML.Document.Parsed, stepIdx: number, field: OverlayField): YAML.YAMLSeq {
  const stepsSeq = getStepsSeq(doc);
  const stepNode = stepsSeq.items[stepIdx];
  if (!YAML.isMap(stepNode)) throw new Error(`step is not a mapping`);
  let seq = stepNode.get(field, true);
  if (seq === undefined) {
    // `setIn` with a plain `[]` stores it as a raw JS array rather than a `YAMLSeq` node (its
    // automatic createNode conversion only kicks in for the path's own leaf when that leaf is
    // itself missing — not reliably here), so push isn't available on it afterwards. Creating
    // the node explicitly avoids that.
    doc.setIn(["steps", stepIdx, field], doc.createNode([]));
    seq = stepNode.get(field, true);
  }
  if (!YAML.isSeq(seq)) throw new Error(`step's "${field}" is not a list`);
  return seq;
}

function findOverlayIndex(seq: YAML.YAMLSeq, id: string): number {
  const idx = seq.items.findIndex((item) => YAML.isMap(item) && item.get("id") === id);
  if (idx === -1) throw new Error(`no "${id}" in this list`);
  return idx;
}

export interface OverlayPatch {
  target?: Target;
  box?: Box;
  label?: string;
}

function applyExclusivePatch(itemNode: YAML.YAMLMap, patch: OverlayPatch, doc: YAML.Document.Parsed): void {
  // target/box are mutually exclusive (same rule the schema enforces) — setting one clears the
  // other, so an edit that re-pins a callout from a box to a target (or back) never leaves a
  // stale sibling field that'd fail validation.
  if (patch.target !== undefined) {
    itemNode.set("target", doc.createNode(patch.target));
    itemNode.delete("box");
  }
  if (patch.box !== undefined) {
    itemNode.set("box", doc.createNode(patch.box));
    itemNode.delete("target");
  }
  if (patch.label !== undefined) {
    if (patch.label === "") itemNode.delete("label");
    else itemNode.set("label", patch.label);
  }
}

/** Adds a numbered callout to a step — appended to the end of its `callouts:` list (so it gets
 * the next number). Exactly one of `target`/`box` must be set, enforced by the schema. */
export function addCallout(
  walkthroughFile: string,
  stepId: string,
  callout: Callout,
  opts: EditOptions = {},
): EditResult<Callout> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "callouts"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "callouts");
  if (seq.items.some((item) => YAML.isMap(item) && item.get("id") === callout.id)) {
    throw new Error(`callout "${callout.id}" already exists on step "${stepId}"`);
  }
  seq.items.push(doc.createNode(callout));
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.callouts.${callout.id}`;
  record(helpRoot, walkthroughFile, opts, "addCallout", target, undefined, callout);
  return { target, before: undefined as unknown as Callout, after: callout };
}

registerRevert("addCallout", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".callouts.");
  const after = entry.after as Callout;
  removeCallout(entry.file, stepId, after.id, { by: entry.by, record: false });
});

/** Patches an existing callout's `target`/`box`/`label` by id. Only the fields given in `patch`
 * change; omit a field to leave it as-is. */
export function updateCallout(
  walkthroughFile: string,
  stepId: string,
  calloutId: string,
  patch: OverlayPatch,
  opts: EditOptions = {},
): EditResult<OverlayPatch> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "callouts"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "callouts");
  const itemIdx = findOverlayIndex(seq, calloutId);
  const itemNode = seq.items[itemIdx] as YAML.YAMLMap;
  const before: OverlayPatch = itemNode.toJSON();
  applyExclusivePatch(itemNode, patch, doc);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.callouts.${calloutId}`;
  record(helpRoot, walkthroughFile, opts, "updateCallout", target, before, patch);
  return { target, before, after: patch };
}

registerRevert("updateCallout", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId, , calloutId] = rest.split(".");
  updateCallout(entry.file, stepId, calloutId, entry.before as OverlayPatch, { by: entry.by, record: false });
});

/** Removes a callout by id. */
export function removeCallout(walkthroughFile: string, stepId: string, calloutId: string, opts: EditOptions = {}): EditResult<Callout | undefined> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "callouts"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "callouts");
  const itemIdx = findOverlayIndex(seq, calloutId);
  const before = (seq.items[itemIdx] as YAML.YAMLMap).toJSON() as Callout;
  seq.items.splice(itemIdx, 1);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.callouts.${calloutId}`;
  record(helpRoot, walkthroughFile, opts, "removeCallout", target, before, undefined);
  return { target, before, after: undefined };
}

registerRevert("removeCallout", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const before = entry.before as Callout;
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".callouts.");
  addCallout(entry.file, stepId, before, { by: entry.by, record: false });
});

/** Reorders a step's callouts (controls their numbering) to match `newOrder` — every existing
 * callout id, in the new order. */
export function reorderCallouts(walkthroughFile: string, stepId: string, newOrder: string[], opts: EditOptions = {}): EditResult<string[]> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "callouts"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "callouts");
  const currentIds = seq.items.map((item) => (YAML.isMap(item) ? (item.get("id") as string) : undefined));
  if (currentIds.some((id) => id === undefined)) throw new Error("reorderCallouts requires every callout to have an id");
  const before = currentIds as string[];
  if (JSON.stringify([...before].sort()) !== JSON.stringify([...newOrder].sort())) {
    throw new Error("newOrder must contain exactly this step's current callout ids");
  }

  const byId = new Map(before.map((id, i) => [id, seq.items[i]]));
  seq.items = newOrder.map((id) => byId.get(id)!);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.callouts`;
  record(helpRoot, walkthroughFile, opts, "reorderCallouts", target, before, newOrder);
  return { target, before, after: newOrder };
}

registerRevert("reorderCallouts", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".callouts");
  reorderCallouts(entry.file, stepId, entry.before as string[], { by: entry.by, record: false });
});

/** Adds a blur box to a step — same target/box pinning rule as `addCallout`, no label/order. */
export function addBlur(walkthroughFile: string, stepId: string, blur: BlurBox, opts: EditOptions = {}): EditResult<BlurBox> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "blur"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "blur");
  if (seq.items.some((item) => YAML.isMap(item) && item.get("id") === blur.id)) {
    throw new Error(`blur box "${blur.id}" already exists on step "${stepId}"`);
  }
  seq.items.push(doc.createNode(blur));
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.blur.${blur.id}`;
  record(helpRoot, walkthroughFile, opts, "addBlur", target, undefined, blur);
  return { target, before: undefined as unknown as BlurBox, after: blur };
}

registerRevert("addBlur", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const after = entry.after as BlurBox;
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".blur.");
  removeBlur(entry.file, stepId, after.id, { by: entry.by, record: false });
});

/** Patches an existing blur box's `target`/`box` by id. */
export function updateBlur(
  walkthroughFile: string,
  stepId: string,
  blurId: string,
  patch: Pick<OverlayPatch, "target" | "box">,
  opts: EditOptions = {},
): EditResult<OverlayPatch> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "blur"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "blur");
  const itemIdx = findOverlayIndex(seq, blurId);
  const itemNode = seq.items[itemIdx] as YAML.YAMLMap;
  const before: OverlayPatch = itemNode.toJSON();
  applyExclusivePatch(itemNode, patch, doc);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.blur.${blurId}`;
  record(helpRoot, walkthroughFile, opts, "updateBlur", target, before, patch);
  return { target, before, after: patch };
}

registerRevert("updateBlur", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const [stepId, , blurId] = rest.split(".");
  updateBlur(entry.file, stepId, blurId, entry.before as OverlayPatch, { by: entry.by, record: false });
});

/** Removes a blur box by id. */
export function removeBlur(walkthroughFile: string, stepId: string, blurId: string, opts: EditOptions = {}): EditResult<BlurBox | undefined> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);
  const idx = findStepIndex(doc, stepId);

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, lockKeys(wtId, stepId, "blur"));
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const seq = getOverlaySeq(doc, idx, "blur");
  const itemIdx = findOverlayIndex(seq, blurId);
  const before = (seq.items[itemIdx] as YAML.YAMLMap).toJSON() as BlurBox;
  seq.items.splice(itemIdx, 1);
  validateDocOrThrow(doc, walkthroughFile);
  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#${stepId}.blur.${blurId}`;
  record(helpRoot, walkthroughFile, opts, "removeBlur", target, before, undefined);
  return { target, before, after: undefined };
}

registerRevert("removeBlur", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const before = entry.before as BlurBox;
  const [, rest] = entry.target.split("#");
  const [stepId] = rest.split(".blur.");
  addBlur(entry.file, stepId, before, { by: entry.by, record: false });
});
