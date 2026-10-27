// Locks: `help/.aida/locks.json`, a flat map of item key -> true. Locking a line of
// narration, a screenshot, a page section or a whole walkthrough means rebuilds and agent
// edits/repairs never change it — they suggest a change instead (docs/scope.md "How edits stay
// safe"). A person using the Studio or editing files directly can always override a lock; see
// EditLockedError.
//
// Item keys are stable, human-readable locators:
//   walkthrough:<id>                    the whole walkthrough
//   step:<walkthroughId>:<stepId>       a whole step
//   step:<walkthroughId>:<stepId>:<field>   one field of a step (say, caption, page_text, title, hold)
//   page:<pageFile>:<blockKey>          one block of a built page
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { aidaDir, findHelpRoot } from "./help-root.js";
import { join } from "node:path";
import { appendHistory, registerRevert } from "./history.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";

export function locksPath(helpRoot: string): string {
  return join(aidaDir(helpRoot), "locks.json");
}

export function readLocks(helpRoot: string): Record<string, true> {
  const file = locksPath(helpRoot);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, true>;
  } catch {
    return {};
  }
}

function writeLocks(helpRoot: string, locks: Record<string, true>): void {
  mkdirSync(aidaDir(helpRoot), { recursive: true });
  writeFileSync(locksPath(helpRoot), `${JSON.stringify(locks, null, 2)}\n`);
}

export function isLocked(helpRoot: string, item: string): boolean {
  return Boolean(readLocks(helpRoot)[item]);
}

function record(helpRoot: string, anchorFile: string, opts: EditOptions, action: "lock" | "unlock", item: string, before: boolean, after: boolean): HistoryEntry {
  const entry: HistoryEntry = { at: new Date().toISOString(), by: opts.by ?? "agent", action, target: item, before, after, file: anchorFile };
  appendHistory(helpRoot, entry);
  return entry;
}

/**
 * Locks `item` (see the key formats above) so agent edits/repairs are rejected — a person using
 * the Studio or editing files directly can still override it. `anchorFile` is any file inside
 * the help app (used only to find `help/.aida/`).
 */
export function lock(anchorFile: string, item: string, opts: EditOptions = {}): EditResult<boolean> {
  const helpRoot = findHelpRoot(anchorFile);
  const before = isLocked(helpRoot, item);
  const locks = readLocks(helpRoot);
  locks[item] = true;
  writeLocks(helpRoot, locks);
  record(helpRoot, anchorFile, opts, "lock", item, before, true);
  return { target: item, before, after: true };
}

/** Unlocks `item`. A no-op (but still recorded) if it wasn't locked. */
export function unlock(anchorFile: string, item: string, opts: EditOptions = {}): EditResult<boolean> {
  const helpRoot = findHelpRoot(anchorFile);
  const before = isLocked(helpRoot, item);
  const locks = readLocks(helpRoot);
  delete locks[item];
  writeLocks(helpRoot, locks);
  record(helpRoot, anchorFile, opts, "unlock", item, before, false);
  return { target: item, before, after: false };
}

registerRevert("lock", (entry) => applyLockState(entry, entry.before as boolean));
registerRevert("unlock", (entry) => applyLockState(entry, entry.before as boolean));

function helpRootFromEntry(entry: HistoryEntry): string {
  if (!entry.file) throw new Error("history entry has no file to find the help root from");
  return findHelpRoot(entry.file);
}

function applyLockState(entry: HistoryEntry, locked: boolean): void {
  const helpRoot = helpRootFromEntry(entry);
  const locks = readLocks(helpRoot);
  if (locked) locks[entry.target] = true;
  else delete locks[entry.target];
  writeLocks(helpRoot, locks);
}

/** True if `item` itself, or any ancestor key implied by `ancestors`, is locked — e.g. a step
 * field is also locked when its step or its whole walkthrough is locked. Pass the broader-to-
 * narrower keys that apply to this edit (e.g. `[walkthrough:x, step:x:s1, step:x:s1:say]`). */
export function isLockedAny(helpRoot: string, keys: string[]): string | undefined {
  const locks = readLocks(helpRoot);
  return keys.find((k) => locks[k]);
}
