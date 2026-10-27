// `aida edit <action> ...`, `aida undo`, `aida catch-up` — the CLI surface over the shared
// edit actions in src/edit/**. Same actions the Studio and (later) the generator MCP server use;
// see docs/scope.md "Editing" and AGENTS.md.
import {
  addBlur,
  addCallout,
  catchUp,
  EditLockedError,
  EditValidationError,
  findHelpRoot,
  insertStep,
  lock,
  readLastCatchUpAt,
  removeBlur,
  removeCallout,
  removeStep,
  reorderCallouts,
  reorderSteps,
  setData,
  setPageBlock,
  setStepActions,
  setStepField,
  undo,
  unlock,
  updateBlur,
  updateCallout,
  writeLastCatchUpAt,
  type EditBy,
  type EditResult,
  type HistoryEntry,
  type OverlayPatch,
  type StepField,
} from "../edit/index.js";
import type { BlurBox, Callout, Camera } from "../walkthrough/types.js";

const EDIT_ACTIONS = [
  "setStepField",
  "setStepActions",
  "reorderSteps",
  "removeStep",
  "insertStep",
  "setData",
  "setPageBlock",
  "lock",
  "unlock",
  "addCallout",
  "updateCallout",
  "removeCallout",
  "reorderCallouts",
  "addBlur",
  "updateBlur",
  "removeBlur",
] as const;
type EditAction = (typeof EDIT_ACTIONS)[number];

function isEditAction(action: string): action is EditAction {
  return (EDIT_ACTIONS as readonly string[]).includes(action);
}

function dispatchEdit(action: EditAction, args: string[], by: EditBy): EditResult {
  switch (action) {
    case "setStepField": {
      const [file, stepId, field, value] = requireArgs(args, 4, "setStepField <walkthroughFile> <stepId> <field> <value>");
      const parsed = field === "hold" ? Number(value) : value;
      return setStepField(file, stepId, field as StepField, parsed, { by });
    }
    case "setStepActions": {
      const [file, stepId, actionsJson] = requireArgs(args, 3, "setStepActions <walkthroughFile> <stepId> <actionsJson>");
      let actions: unknown;
      try {
        actions = JSON.parse(actionsJson);
      } catch (err) {
        throw new Error(`setStepActions: <actionsJson> is not valid JSON — ${(err as Error).message}`);
      }
      return setStepActions(file, stepId, actions, { by });
    }
    case "reorderSteps": {
      const [file, order] = requireArgs(args, 2, "reorderSteps <walkthroughFile> <id1,id2,...>");
      return reorderSteps(file, order.split(",").map((s) => s.trim()), { by });
    }
    case "removeStep": {
      const [file, stepId] = requireArgs(args, 2, "removeStep <walkthroughFile> <stepId>");
      return removeStep(file, stepId, { by });
    }
    case "insertStep": {
      const [file, ...rest] = args;
      if (!file) {
        throw new Error(
          'aida edit insertStep <walkthroughFile> --after <stepId>|--before <stepId>|--at-start --id <newId> --do "..." [--say ..] [--caption ..] [--page-text ..] [--title ..] [--chapter ..] [--camera full|<targetJson>] — got 0 argument(s)',
        );
      }
      const flags = parseFlags(
        rest,
        ["after", "before", "id", "do", "say", "caption", "page-text", "title", "chapter", "camera"],
        ["at-start"],
      );
      if (!flags.id) throw new Error("insertStep: --id <newId> is required");
      return insertStep(
        file,
        {
          after: flags.after as string | undefined,
          before: flags.before as string | undefined,
          atStart: flags["at-start"] === true,
          id: flags.id as string,
          do: flags.do as string | undefined,
          say: flags.say as string | undefined,
          caption: flags.caption as string | undefined,
          pageText: flags["page-text"] as string | undefined,
          title: flags.title as string | undefined,
          chapter: flags.chapter as string | undefined,
          camera: flags.camera !== undefined ? parseCameraFlag(flags.camera as string) : undefined,
        },
        { by },
      );
    }
    case "setData": {
      const [file, dottedPath, value] = requireArgs(args, 3, "setData <walkthroughFile> <dotted.path> <value>");
      return setData(file, dottedPath, value, { by });
    }
    case "setPageBlock": {
      const [file, key, text] = requireArgs(args, 3, "setPageBlock <pageFile> <key> <text>");
      return setPageBlock(file, key, text, { by });
    }
    case "addCallout": {
      const [file, stepId, calloutJson] = requireArgs(args, 3, "addCallout <walkthroughFile> <stepId> <calloutJson>");
      return addCallout(file, stepId, parseJsonArg<Callout>(calloutJson, "addCallout"), { by });
    }
    case "updateCallout": {
      const [file, stepId, calloutId, patchJson] = requireArgs(args, 4, "updateCallout <walkthroughFile> <stepId> <calloutId> <patchJson>");
      return updateCallout(file, stepId, calloutId, parseJsonArg<OverlayPatch>(patchJson, "updateCallout"), { by });
    }
    case "removeCallout": {
      const [file, stepId, calloutId] = requireArgs(args, 3, "removeCallout <walkthroughFile> <stepId> <calloutId>");
      return removeCallout(file, stepId, calloutId, { by });
    }
    case "reorderCallouts": {
      const [file, stepId, order] = requireArgs(args, 3, "reorderCallouts <walkthroughFile> <stepId> <id1,id2,...>");
      return reorderCallouts(file, stepId, order.split(",").map((s) => s.trim()), { by });
    }
    case "addBlur": {
      const [file, stepId, blurJson] = requireArgs(args, 3, "addBlur <walkthroughFile> <stepId> <blurJson>");
      return addBlur(file, stepId, parseJsonArg<BlurBox>(blurJson, "addBlur"), { by });
    }
    case "updateBlur": {
      const [file, stepId, blurId, patchJson] = requireArgs(args, 4, "updateBlur <walkthroughFile> <stepId> <blurId> <patchJson>");
      return updateBlur(file, stepId, blurId, parseJsonArg<Pick<OverlayPatch, "target" | "box">>(patchJson, "updateBlur"), { by });
    }
    case "removeBlur": {
      const [file, stepId, blurId] = requireArgs(args, 3, "removeBlur <walkthroughFile> <stepId> <blurId>");
      return removeBlur(file, stepId, blurId, { by });
    }
    case "lock": {
      const [anchor, item] = requireArgs(args, 2, "lock <anchorFile> <item>");
      return lock(anchor, item, { by });
    }
    case "unlock": {
      const [anchor, item] = requireArgs(args, 2, "unlock <anchorFile> <item>");
      return unlock(anchor, item, { by });
    }
  }
}

/** Parses `insertStep --camera`'s value: the literal `full`, a full camera object JSON
 * (`{"focus":{...},"zoom":1.25}`), or a bare target JSON (`{"role":"button","name":"X"}`) —
 * the common case — which is wrapped as `{ focus: <target> }`. Schema validation (via
 * `validateDocOrThrow` inside `insertStep`) rejects anything that isn't a well-formed camera. */
function parseCameraFlag(raw: string): Camera {
  if (raw === "full") return "full";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`insertStep: --camera "${raw}" is not "full" or valid JSON — ${(err as Error).message}`);
  }
  if (value && typeof value === "object" && "focus" in (value as Record<string, unknown>)) {
    return value as Camera;
  }
  return { focus: value } as Camera;
}

/** Parses `--flag value` / `--boolean-flag` pairs out of a raw args array (used by `insertStep`,
 * whose position/field options aren't declared on the `edit` command — see cli.ts). `valueFlags`
 * take the next token as their value; `boolFlags` take no value. Throws on an unrecognised
 * `--flag` or a value-flag given with nothing after it. */
function parseFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`insertStep: unexpected argument "${token}" (expected a --flag)`);
    }
    const name = token.slice(2);
    if (boolFlags.includes(name)) {
      out[name] = true;
      i += 1;
      continue;
    }
    if (valueFlags.includes(name)) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`insertStep: --${name} needs a value`);
      out[name] = value;
      i += 2;
      continue;
    }
    throw new Error(`insertStep: unknown flag "--${name}"`);
  }
  return out;
}

function requireArgs(args: string[], count: number, usage: string): string[] {
  if (args.length < count) {
    throw new Error(`aida edit ${usage} — got ${args.length} argument(s)`);
  }
  return args;
}

function parseJsonArg<T>(raw: string, action: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${action}: argument is not valid JSON — ${(err as Error).message}`);
  }
}

function shortMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/** Runs `aida edit <action> [args...]`. */
export function runEditCommand(action: string, args: string[], opts: { by?: EditBy; json?: boolean }): number {
  const by = opts.by ?? "agent";
  if (!isEditAction(action)) {
    const message = `unknown edit action "${action}" (expected one of: ${EDIT_ACTIONS.join(", ")})`;
    if (opts.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`error: ${message}`);
    return 1;
  }

  try {
    const result = dispatchEdit(action, args, by);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, action, ...result }));
    } else {
      console.log(`${action} ${result.target}: ${JSON.stringify(result.before)} -> ${JSON.stringify(result.after)}`);
    }
    return 0;
  } catch (err) {
    const message = shortMessage(err);
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: message, locked: err instanceof EditLockedError, invalid: err instanceof EditValidationError }));
    } else {
      console.error(`edit rejected: ${message}`);
    }
    return 1;
  }
}

/** Runs `aida undo [--by agent|person]`, from inside (or above) a help app directory. */
export function runUndoCommand(dir: string | undefined, opts: { by?: EditBy; json?: boolean }): number {
  try {
    const helpRoot = findHelpRoot(dir ?? process.cwd());
    const { reverted, entry } = undo(helpRoot, opts.by);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, reverted, entry }));
    } else {
      console.log(`undid ${reverted.action} on ${reverted.target} (was by ${reverted.by})`);
    }
    return 0;
  } catch (err) {
    const message = shortMessage(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`undo failed: ${message}`);
    return 1;
  }
}

/** Runs `aida catch-up [--since <iso|last>]`: what a person changed in the Studio since a
 * point in time, for an agent to read at the start of a turn. */
export function runCatchUpCommand(dir: string | undefined, since: string | undefined, opts: { json?: boolean }): number {
  try {
    const helpRoot = findHelpRoot(dir ?? process.cwd());
    let sinceIso: string | undefined;
    let persistAfter = false;
    if (since === "last") {
      sinceIso = readLastCatchUpAt(helpRoot);
      persistAfter = true;
    } else if (since) {
      sinceIso = since;
    }

    const now = new Date().toISOString();
    const entries: HistoryEntry[] = catchUp(helpRoot, sinceIso);
    if (persistAfter) writeLastCatchUpAt(helpRoot, now);

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, since: sinceIso, entries }));
    } else if (entries.length === 0) {
      console.log(sinceIso ? `no edits by a person since ${sinceIso}` : "no edits by a person yet");
    } else {
      console.log(`${entries.length} edit(s) by a person${sinceIso ? ` since ${sinceIso}` : ""}:`);
      for (const e of entries) {
        console.log(`  ${e.at}  ${e.action} ${e.target}`);
      }
    }
    return 0;
  } catch (err) {
    const message = shortMessage(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`catch-up failed: ${message}`);
    return 1;
  }
}
