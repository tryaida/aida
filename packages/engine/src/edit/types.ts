// Shared types for the edit module. One small set of edit actions used by the Studio, the CLI
// (`aida edit`/`aida undo`/`aida catch-up`) and, later, the generator MCP server — see
// docs/scope.md "Editing" and decisions #9/#19. Phase 1 scope only: walkthrough step fields,
// step order/removal, page text blocks and locks. Timeline/callouts/blur are Phase 2.

/** Who made an edit — carried through history so `undo`/`catch-up` can filter by author. */
export type EditBy = "person" | "agent";

/** One entry in `help/.aida/history.jsonl`. Append-only: `undo` appends a reverting entry
 * rather than removing history, so the log is always a complete, replayable record. */
export interface HistoryEntry {
  /** ISO timestamp. */
  at: string;
  by: EditBy;
  /** The edit action's name, e.g. "setStepField", "reorderSteps", "undo:setStepField". */
  action: string;
  /** A stable, human-readable locator for what changed, e.g. "add-competitor-and-entry#check-show.say". */
  target: string;
  before: unknown;
  after: unknown;
  /** The file the edit was made to (walkthrough or page file), absolute path. Not part of the
   * minimal {at, by, action, target, before, after} shape callers see, but carried so `undo` can
   * find the file again without re-deriving it from `target`. */
  file?: string;
  /** Only on an `undo:<action>` entry: the index (into the full `readHistory()` array) of the
   * entry it undid, so a later `undo` never re-targets an already-undone entry (which would
   * effectively redo it). */
  undoOf?: number;
}

export interface EditOptions {
  /** Who is making the edit. Default "agent" (CLI/MCP default; Studio passes "person"). */
  by?: EditBy;
  /** Internal: set to `false` by `undo()` when it invokes an action's registered revert, so the
   * revert's own write doesn't append a second, indistinguishable history entry — `undo()`
   * appends the single `undo:<action>` entry itself. Callers outside the edit module should
   * never set this. */
  record?: boolean;
  /** `setPageBlock` only: the pages directory the resolved `pageFile` must stay inside. Any
   * caller taking a page file from an untrusted source (e.g. an HTTP request body) MUST pass
   * this — it's what stops a path-traversal write to an arbitrary file. */
  pagesDir?: string;
}

/** Thrown when an edit would change the walkthrough into something the schema rejects. The
 * walkthrough file is left untouched. */
export class EditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditValidationError";
  }
}

/** Thrown when an agent edit (`by: "agent"`) targets a locked item. Locks only block agent
 * edits/repairs (scope.md: "Rebuilds and agent repairs never change locked items; they suggest a
 * change instead") — a person using the Studio or editing files directly can always override. */
export class EditLockedError extends Error {
  constructor(public readonly item: string) {
    super(`"${item}" is locked and can't be changed by an agent edit — ask the person to unlock it, or edit it in the Studio.`);
    this.name = "EditLockedError";
  }
}

/** The result of one edit action: enough to show the person what changed and to build a history entry. */
export interface EditResult<T = unknown> {
  target: string;
  before: T;
  after: T;
}
