// Edit history: `help/.aida/history.jsonl`, one JSON `HistoryEntry` per line, append-only.
// `undo` reverts an edit by appending a new entry that applies the inverse — the log always
// stays a complete, replayable record (never rewritten or truncated).
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { aidaDir, findHelpRoot } from "./help-root.js";
import type { EditBy, HistoryEntry } from "./types.js";

export function historyPath(helpRoot: string): string {
  return join(aidaDir(helpRoot), "history.jsonl");
}

/** Appends one entry to the history log. Used internally by every edit action. */
export function appendHistory(helpRoot: string, entry: HistoryEntry): void {
  appendFileSync(historyPath(helpRoot), `${JSON.stringify(entry)}\n`);
}

/** Reads the full history log, oldest first. Empty array if no edits have been made yet. */
export function readHistory(helpRoot: string): HistoryEntry[] {
  const file = historyPath(helpRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HistoryEntry);
}

export interface UndoResult {
  reverted: HistoryEntry;
  entry: HistoryEntry;
}

/** A revert function one edit module registers for its action name, so `undo` can invert it
 * without the history module needing to know about walkthroughs or page files. */
export type RevertFn = (entry: HistoryEntry) => void;

const revertFns = new Map<string, RevertFn>();

/** Registers how to invert one action by name. Called once per action at module load. */
export function registerRevert(action: string, fn: RevertFn): void {
  revertFns.set(action, fn);
}

/**
 * Reverts the last edit in `helpRoot`'s history — the last entry overall, or (with `lastBy`)
 * the last entry made by that author, leaving every other entry (including later edits by
 * someone else) alone. Appends an `undo:<action>` entry recording the revert; throws if there's
 * nothing to undo or the action has no registered revert.
 */
export function undo(helpRoot: string, lastBy?: EditBy): UndoResult {
  const entries = readHistory(helpRoot);
  const idx = findLastUndoable(entries, lastBy);
  if (idx === -1) {
    throw new Error(lastBy ? `no edit by "${lastBy}" to undo` : "no edit to undo");
  }
  const target = entries[idx];
  const revert = revertFns.get(target.action);
  if (!revert) {
    throw new Error(`don't know how to undo "${target.action}"`);
  }
  // The revert writes the file change but must not record its own history entry — otherwise
  // it'd be indistinguishable from a genuine new edit by `target.by`, and a later `undo --by
  // <that author>` would find and re-revert it (redoing the very edit this undo just reverted).
  // The single `undo:<action>` entry below is the only history record of this revert.
  revert(target);

  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    by: target.by,
    action: `undo:${target.action}`,
    target: target.target,
    before: target.after,
    after: target.before,
    undoOf: idx,
  };
  appendHistory(helpRoot, entry);
  return { reverted: target, entry };
}

function findLastUndoable(entries: HistoryEntry[], lastBy?: EditBy): number {
  const undone = new Set<number>();
  for (const e of entries) {
    if (e.action.startsWith("undo:") && typeof e.undoOf === "number") undone.add(e.undoOf);
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].action.startsWith("undo:")) continue; // undo entries are a record, not an undoable edit
    if (undone.has(i)) continue; // already undone — re-targeting it would redo it
    if (lastBy && entries[i].by !== lastBy) continue;
    return i;
  }
  return -1;
}

/** Compact catch-up list: every edit made by a person since `sinceIso` (or all of them, if
 * omitted), oldest first — what `aida catch-up` shows the agent at the start of a turn. */
export function catchUp(helpRoot: string, sinceIso?: string): HistoryEntry[] {
  const entries = readHistory(helpRoot).filter((e) => e.by === "person");
  if (!sinceIso) return entries;
  return entries.filter((e) => e.at > sinceIso);
}

/** `help/.aida/catchup-state.json` — tracks, per-agent key, the timestamp of its last
 * `aida catch-up --since last` call, so the next call without an explicit ISO picks up where
 * it left off. */
export function catchUpStatePath(helpRoot: string): string {
  return join(aidaDir(helpRoot), "catchup-state.json");
}

export function readLastCatchUpAt(helpRoot: string): string | undefined {
  const file = catchUpStatePath(helpRoot);
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { lastAt?: string };
    return state.lastAt;
  } catch {
    return undefined;
  }
}

export function writeLastCatchUpAt(helpRoot: string, at: string): void {
  mkdirSync(aidaDir(helpRoot), { recursive: true });
  writeFileSync(catchUpStatePath(helpRoot), `${JSON.stringify({ lastAt: at }, null, 2)}\n`);
}

export { findHelpRoot };
