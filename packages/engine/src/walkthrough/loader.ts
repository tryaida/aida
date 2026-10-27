import { readFileSync } from "node:fs";
import * as YAML from "yaml";
import { WalkthroughDocSchema, docToWalkthrough } from "./schema.js";
import { normaliseStart, personaConflict } from "./persona.js";
import type { Walkthrough } from "./types.js";

/** A validation problem with a short message and, where known, a location. */
export interface WalkthroughError {
  message: string;
  file: string;
  line?: number;
  path: string;
}

export class WalkthroughValidationError extends Error {
  constructor(public readonly errors: WalkthroughError[]) {
    super(errors.map((e) => formatError(e)).join("\n"));
    this.name = "WalkthroughValidationError";
  }
}

function formatError(e: WalkthroughError): string {
  const loc = e.line ? `${e.file}:${e.line}` : e.file;
  return `${loc}: ${e.message}${e.path ? ` (at ${e.path})` : ""}`;
}

/** Parses and validates one walkthrough YAML file, returning its typed form. */
export function loadWalkthroughFile(file: string): Walkthrough {
  const text = readFileSync(file, "utf8");
  return loadWalkthroughText(text, file);
}

/** Parses and validates walkthrough YAML already read into memory. */
export function loadWalkthroughText(text: string, file = "<walkthrough>"): Walkthrough {
  const lineCounter = new YAML.LineCounter();
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(text, { lineCounter, prettyErrors: true });
  } catch (err) {
    throw new WalkthroughValidationError([
      { message: `could not parse YAML: ${(err as Error).message}`, file, path: "" },
    ]);
  }
  if (doc.errors.length > 0) {
    throw new WalkthroughValidationError(
      doc.errors.map((e) => ({ message: e.message, file, line: lineOf(lineCounter, e), path: "" })),
    );
  }

  const raw: unknown = doc.toJS();
  const result = WalkthroughDocSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      const node = path ? doc.getIn(issue.path, true) : undefined;
      const line = node && hasRange(node) ? lineCounter.linePos(node.range[0]).line : undefined;
      return { message: issue.message, file, line, path };
    });
    throw new WalkthroughValidationError(errors);
  }

  // One persona everywhere: a walkthrough that names two different roles is an error, not a
  // silent pick (an admin walkthrough once signed in as staff and captured a blank page).
  const conflict = personaConflict(result.data.start);
  if (conflict) {
    const node = doc.getIn(["start", "signed_in_as"], true);
    throw new WalkthroughValidationError([
      {
        message: `start.signed_in_as is "${conflict.signedInAs}" but start.persona.role is "${conflict.role}"; keep one, or make them match`,
        file,
        line: node && hasRange(node) ? lineCounter.linePos(node.range[0]).line : undefined,
        path: "start.signed_in_as",
      },
    ]);
  }

  const walkthrough = docToWalkthrough(result.data);
  // In memory only: edit/ and the Studio write the raw YAML document, never this object.
  return { ...walkthrough, start: normaliseStart(walkthrough.start) };
}

/**
 * Finds the line a value sits on in walkthrough YAML, e.g. `["steps", 2, "caption"]`. For
 * reporting problems found after loading (validate's text checks) against the file as written.
 */
export function yamlLineLocator(text: string): (path: (string | number)[]) => number | undefined {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter });
  return (path) => {
    const node = doc.getIn(path, true);
    return node && hasRange(node) ? lineCounter.linePos(node.range[0]).line : undefined;
  };
}

function hasRange(node: unknown): node is { range: [number, number, number] } {
  return Boolean(node && typeof node === "object" && "range" in node && Array.isArray((node as { range: unknown }).range));
}

function lineOf(lineCounter: YAML.LineCounter, e: { pos?: [number, number] }): number | undefined {
  return e.pos ? lineCounter.linePos(e.pos[0]).line : undefined;
}
