// Load/save a walkthrough YAML file through `yaml`'s Document API, so edits preserve comments
// and formatting everywhere except the node actually touched (docs/scope.md: "Edit YAML
// preserving comments/formatting").
import { readFileSync, writeFileSync } from "node:fs";
import * as YAML from "yaml";
import { loadWalkthroughText, WalkthroughValidationError } from "../walkthrough/loader.js";
import type { Walkthrough } from "../walkthrough/types.js";
import { EditValidationError } from "./types.js";

export function readYamlDocument(file: string): YAML.Document.Parsed {
  const text = readFileSync(file, "utf8");
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new WalkthroughValidationError(
      doc.errors.map((e) => ({ message: e.message, file, path: "" })),
    );
  }
  return doc;
}

/** Validates `doc` against the walkthrough schema before writing anything to disk. Throws
 * `EditValidationError` (never writes) if the edit would make the file invalid — including a
 * `do:`/`check:` plain-words string the walkthrough parser (`parseDoString`/`parseCheck`,
 * invoked via `docToWalkthrough` once schema validation passes) can't parse: that throws a
 * plain `Error`, not `WalkthroughValidationError`, so it's caught here too rather than only the
 * schema-shape case. */
export function validateDocOrThrow(doc: YAML.Document.Parsed, file: string): Walkthrough {
  const text = doc.toString();
  try {
    return loadWalkthroughText(text, file);
  } catch (err) {
    if (err instanceof WalkthroughValidationError) {
      throw new EditValidationError(`edit rejected — ${err.message}`);
    }
    if (err instanceof Error) {
      throw new EditValidationError(`edit rejected — ${err.message}`);
    }
    throw err;
  }
}

/** Validates, then writes `doc` to `file`. Only called once validation has passed. */
export function writeYamlDocument(file: string, doc: YAML.Document.Parsed): void {
  writeFileSync(file, doc.toString());
}

/** Finds a step's index in the YAML seq by its `id` field. Throws with a clear message if missing. */
export function findStepIndex(doc: YAML.Document.Parsed, stepId: string): number {
  const steps = doc.get("steps", true);
  if (!YAML.isSeq(steps)) throw new Error("walkthrough has no steps");
  const index = steps.items.findIndex((item) => YAML.isMap(item) && item.get("id") === stepId);
  if (index === -1) throw new Error(`no step with id "${stepId}"`);
  return index;
}

export function getStepsSeq(doc: YAML.Document.Parsed): YAML.YAMLSeq {
  const steps = doc.get("steps", true);
  if (!YAML.isSeq(steps)) throw new Error("walkthrough has no steps");
  return steps;
}

export function walkthroughId(doc: YAML.Document.Parsed): string {
  return String(doc.get("walkthrough"));
}
