// `setData` edit action: changes a value inside a walkthrough's `data:` block (the values steps
// reference via `{{dotted.path}}` — see walkthrough/template.ts). Before this, repair agents had
// no edit action for `data:` and hand-edited the YAML directly, bypassing locks/history/validation
// (build-plan.md M14 log). Lives alongside steps.ts/page.ts as one more shared edit action.
import * as YAML from "yaml";
import { appendHistory, registerRevert } from "./history.js";
import { findHelpRoot } from "./help-root.js";
import { isLockedAny } from "./locks.js";
import { readYamlDocument, validateDocOrThrow, walkthroughId, writeYamlDocument } from "./yaml-doc.js";
import { findUnresolvedTemplates } from "../walkthrough/template.js";
import { EditLockedError, EditValidationError } from "./types.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";

function record(helpRoot: string, file: string, opts: EditOptions, target: string, before: unknown, after: unknown): HistoryEntry {
  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    by: opts.by ?? "agent",
    action: "setData",
    target,
    before,
    after,
    file,
  };
  if (opts.record !== false) appendHistory(helpRoot, entry);
  return entry;
}

/** Every `{{path}}` across a walkthrough's steps/intro/outro/validate with no matching `data` —
 * same check `aida validate` runs (commands/validate.ts), duplicated here as a write-time gate
 * so a `setData` that breaks another step's reference is rejected before it's written, not left
 * for the next `validate` run to catch. */
function unresolvedTemplatesAfterEdit(doc: YAML.Document.Parsed, file: string): string[] {
  const wt = validateDocOrThrow(doc, file);
  const data = wt.data ?? {};
  const unresolved = new Set<string>();
  for (const p of findUnresolvedTemplates(wt.steps, data)) unresolved.add(p);
  if (wt.intro) for (const p of findUnresolvedTemplates(wt.intro, data)) unresolved.add(p);
  if (wt.outro) for (const p of findUnresolvedTemplates(wt.outro, data)) unresolved.add(p);
  if (wt.validate) for (const p of findUnresolvedTemplates(wt.validate, data)) unresolved.add(p);
  return [...unresolved];
}

/** Sets one value inside a walkthrough's `data:` block, addressed by a dotted path
 * (`competitor.phone`). `value` is a raw string, parsed as a YAML scalar (so `42`, `true`,
 * `"quoted"` and a bare word all come out as the type a person would expect) — rejects
 * (without writing) if the result fails schema validation, or leaves any `{{...}}` placeholder
 * in the walkthrough unresolved, or if an agent edit targets a locked walkthrough/data path. */
export function setData(
  walkthroughFile: string,
  dottedPath: string,
  value: string,
  opts: EditOptions = {},
): EditResult {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(walkthroughFile);
  const doc = readYamlDocument(walkthroughFile);
  const wtId = walkthroughId(doc);

  const pathParts = dottedPath.split(".");
  if (pathParts.length === 0 || pathParts.some((p) => p.length === 0)) {
    throw new Error(`setData: "${dottedPath}" is not a valid dotted path`);
  }

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, [`walkthrough:${wtId}`, `data:${wtId}:${dottedPath}`]);
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(value);
  } catch (err) {
    throw new EditValidationError(`setData: "${value}" is not a valid YAML scalar — ${(err as Error).message}`);
  }

  const before = doc.getIn(["data", ...pathParts]);
  doc.setIn(["data", ...pathParts], parsed);

  const unresolved = unresolvedTemplatesAfterEdit(doc, walkthroughFile);
  if (unresolved.length > 0) {
    throw new EditValidationError(
      `setData rejected — would leave unresolved template placeholder(s): ${unresolved.map((p) => `{{${p}}}`).join(", ")}`,
    );
  }

  writeYamlDocument(walkthroughFile, doc);

  const target = `${wtId}#data.${dottedPath}`;
  record(helpRoot, walkthroughFile, opts, target, before, parsed);
  return { target, before, after: parsed };
}

registerRevert("setData", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const [, rest] = entry.target.split("#");
  const dottedPath = rest.slice("data.".length);
  const beforeYaml = entry.before === undefined ? "null" : YAML.stringify(entry.before).trim();
  setData(entry.file, dottedPath, beforeYaml, { by: entry.by, record: false });
});
