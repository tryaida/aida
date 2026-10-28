// What the Studio shows about a walkthrough's last capture beyond pass/fail (M39): the failure
// report's suspected owner and reason (decision 30), and the drift recorded on its outline card
// (M29). Plain file reads, so the help app's Studio routes stay thin (AGENTS.md): they call these
// with paths they resolved themselves. Imports nothing that a route handler's bundler can't trace.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureCategory, FailureReport } from "../capture/types.js";
import { describeDrift } from "../outline/drift.js";
import { findCard, outlinePath, readOutline, type OutlineConfigLike } from "../outline/file.js";

export { outlinePath, type OutlineConfigLike };

/** The last capture's failure, trimmed to what a person reads first. */
export interface LastFailure {
  category: FailureCategory;
  /** Plain words, e.g. "possible app bug (not a docs problem)". */
  label: string;
  reason: string;
  /** The failing step's id, when it was a step. */
  step?: string;
  /** First line of the error (already redacted when the report was written). */
  error: string;
}

/** One name on the outline card that differs from the screen. */
export interface OutlineDriftItem {
  expected: string;
  seen?: string;
  step?: string;
  source: "capture" | "writer";
  /** One line, e.g. `"Save session" (saw "Add session" at step add)`. */
  text: string;
}

const LABEL: Record<FailureCategory, string> = {
  walkthrough: "walkthrough problem",
  app: "possible app bug (not a docs problem)",
  environment: "setup problem (not the walkthrough)",
  undetermined: "can't tell: the walkthrough or the app",
};

const CATEGORIES = new Set<string>(["walkthrough", "app", "environment", "undetermined"]);

/**
 * `<captureDir>/failure.json`, the report the last capture left (it's removed on a passing run),
 * or `undefined` when there is none or it doesn't read. A report from before categories existed
 * counts as a walkthrough problem.
 */
export function lastFailure(captureDir: string): LastFailure | undefined {
  const file = join(captureDir, "failure.json");
  if (!existsSync(file)) return undefined;
  let report: Partial<FailureReport>;
  try {
    report = JSON.parse(readFileSync(file, "utf8")) as Partial<FailureReport>;
  } catch {
    return undefined;
  }
  if (!report || typeof report !== "object") return undefined;
  const category: FailureCategory = typeof report.category === "string" && CATEGORIES.has(report.category) ? report.category : "walkthrough";
  const error = typeof report.error === "string" ? report.error : "";
  const reason = typeof report.reason === "string" && report.reason ? report.reason : error;
  return {
    category,
    label: LABEL[category],
    reason,
    ...(typeof report.step === "string" && report.step ? { step: report.step } : {}),
    error,
  };
}

/**
 * Every card's drift in `outlineFile`, read once, by card id (= walkthrough id). Dropped cards and
 * cards with no drift are left out; empty when there's no outline or it doesn't read (`aida
 * outline check` reports that).
 */
export function outlineDriftIndex(outlineFile: string): Map<string, OutlineDriftItem[]> {
  const out = new Map<string, OutlineDriftItem[]>();
  let loaded;
  try {
    loaded = readOutline(outlineFile);
  } catch {
    return out;
  }
  for (const card of loaded?.outline.cards ?? []) {
    if (card.status === "dropped" || !card.drift?.length || out.has(card.id)) continue;
    out.set(
      card.id,
      card.drift.map((d) => ({
        expected: d.expected,
        ...(d.seen ? { seen: d.seen } : {}),
        ...(d.step ? { step: d.step } : {}),
        source: d.source,
        text: describeDrift(d),
      })),
    );
  }
  return out;
}

/** The drift on walkthrough `id`'s outline card (see `outlineDriftIndex`). */
export function outlineDriftFor(outlineFile: string, id: string): OutlineDriftItem[] {
  return outlineDriftIndex(outlineFile).get(id) ?? [];
}

/** Both, for one walkthrough: the Studio's list row and its walkthrough header. `drift`: an
 * `outlineDriftIndex` already read (a list reads the outline once), else the outline file. */
export function walkthroughHealth(
  captureDir: string,
  outline: string | Map<string, OutlineDriftItem[]>,
  id: string,
): { failure?: LastFailure; drift: OutlineDriftItem[] } {
  const failure = lastFailure(captureDir);
  const drift = typeof outline === "string" ? outlineDriftFor(outline, id) : (outline.get(id) ?? []);
  return { ...(failure ? { failure } : {}), drift };
}

/** `text` with comments blanked out (same length, so offsets still line up); strings kept. */
function blankComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      const stop = stringEnd(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Index just past the string literal starting at `start`. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === "\\") j += 1;
    else if (quote !== "`" && text[j] === "\n") break;
    j += 1;
  }
  return Math.min(j + 1, text.length);
}

/**
 * A config field written as a plain string literal at the top level of the config object
 * (`defineConfig({ outline: "plan/outline.yaml" })` or `export default { … }`), read from the
 * config file's text, for the Studio: a route handler can't load `aida.config.ts` (its loader's
 * dynamic `import()` can't be bundled). Commented-out keys, keys inside nested objects and keys
 * in strings never count; a computed value (a variable, a template with `${…}`) reads as
 * undefined, so the caller falls back to the default, as the engine would for a missing key.
 */
export function configLiteral(configText: string, key: string): string | undefined {
  const text = blankComments(configText);
  const opener = /\bdefineConfig\s*\(\s*\{|\bexport\s+default\s*\{/.exec(text);
  let i = opener ? opener.index + opener[0].length : 0;
  let depth = opener ? 1 : 0;
  let prev = opener ? "{" : "";
  const keyPattern = new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:\\s*(["'\`])`);
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (depth === 1 && (prev === "{" || prev === ",")) {
      const m = keyPattern.exec(text.slice(i, i + key.length + 64));
      if (m) {
        const valueStart = i + m[0].length - 1;
        const end = stringEnd(text, valueStart);
        const value = text.slice(valueStart + 1, end - 1);
        if (text[end - 1] !== m[1] || value.includes("\\") || (m[1] === "`" && value.includes("${"))) return undefined;
        return value;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(text, i);
      prev = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (opener && depth === 0) return undefined;
    }
    prev = c;
    i += 1;
  }
  return undefined;
}
