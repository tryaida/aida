import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import {
  emailKeysIn,
  findUnresolvedTemplates,
  loadWalkthroughText,
  unresolvedDisplayText,
  WalkthroughValidationError,
  type Walkthrough,
} from "../walkthrough/index.js";
import { checkWalkthroughText } from "../qa/walkthrough-text.js";
import { applyStateChecks } from "../states/validate.js";

export interface ValidateResult {
  file: string;
  ok: boolean;
  walkthrough?: string;
  errors?: ValidateError[];
  /** Problems that don't fail the file, e.g. a `{{run.id}}` that reaches the screen. */
  warnings?: ValidateError[];
}

export interface ValidateOptions {
  /** Config `states` (from `--config`), so state names can be checked against it. */
  states?: Record<string, { setup?: unknown; check?: unknown; as?: string }>;
  /** Config `roles` (from `--config`): with the walkthroughs' personas, the roles `as:` may name. */
  roles?: Record<string, unknown>;
}

export interface ValidateError {
  message: string;
  line?: number;
  path: string;
  /** Set for a text QA problem: the QA check it would fail later, e.g. "captions:line-length". */
  check?: string;
  /** Step id ("intro"/"outro" for the title cards), for a text QA problem. */
  step?: string;
  /** The offending text exactly as written, for a text QA problem. */
  text?: string;
}

/** Finds `.yaml`/`.yml` files under a directory, or returns a single file as-is. */
export function findWalkthroughFiles(target: string): string[] {
  const stat = statSync(target);
  if (stat.isFile()) return [target];

  const files: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...findWalkthroughFiles(path));
    } else if ([".yaml", ".yml"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

/** Every `{{path}}` in `wt` with no matching `data`, across steps/intro/outro/validate. */
function unresolvedTemplatesIn(wt: Walkthrough): string[] {
  const data = wt.data ?? {};
  const unresolved = new Set<string>();
  for (const p of findUnresolvedTemplates(wt.steps, data)) unresolved.add(p);
  for (const path of wt.paths ?? []) for (const p of findUnresolvedTemplates(path.steps, data)) unresolved.add(p);
  if (wt.intro) for (const p of findUnresolvedTemplates(wt.intro, data)) unresolved.add(p);
  if (wt.outro) for (const p of findUnresolvedTemplates(wt.outro, data)) unresolved.add(p);
  if (wt.validate) for (const p of findUnresolvedTemplates(wt.validate, data)) unresolved.add(p);
  return [...unresolved];
}

/** `{{inbox.<key>}}` used before any `showEmail` remembers that key (in step order; setup steps
 * can't show email). */
export function emailValueProblems(wt: Walkthrough): string[] {
  const problems: string[] = [];
  const known = new Set<string>();
  for (const step of wt.steps) {
    for (const a of step.actions ?? []) {
      const used = a.do === "type" ? a.text : a.do === "goto" ? a.path : a.do === "expect" ? (a.text ?? "") : "";
      for (const key of emailKeysIn(used)) {
        if (!known.has(key)) problems.push(`step "${step.id}": {{inbox.${key}}} is used before a showEmail remembers "${key}"`);
      }
      if (a.do === "showEmail") for (const key of Object.keys(a.remember ?? {})) known.add(key);
    }
  }
  return problems;
}

/** Marks every result sharing a `walkthrough` id with another file in the same run as invalid. */
function markDuplicateIds(results: ValidateResult[]): ValidateResult[] {
  const filesById = new Map<string, string[]>();
  for (const r of results) {
    if (r.ok && r.walkthrough) {
      filesById.set(r.walkthrough, [...(filesById.get(r.walkthrough) ?? []), r.file]);
    }
  }
  const duplicateIds = new Set([...filesById.entries()].filter(([, files]) => files.length > 1).map(([id]) => id));
  if (duplicateIds.size === 0) return results;

  return results.map((r) => {
    if (!r.ok || !r.walkthrough || !duplicateIds.has(r.walkthrough)) return r;
    const others = filesById.get(r.walkthrough)!.filter((f) => f !== r.file);
    return {
      ...r,
      ok: false,
      errors: [
        {
          message: `duplicate walkthrough id "${r.walkthrough}" — also used by ${others.join(", ")}`,
          path: "walkthrough",
        },
      ],
    };
  });
}

/**
 * Validates one file: schema/YAML errors, unresolved `{{...}}` templates against `data`, and the
 * QA checks that only need the text (caption and chapter-title line length; qa/walkthrough-text.ts)
 * — so they fail here, not after voice and render.
 */
function validateFile(file: string): ValidateResult {
  try {
    const source = readFileSync(file, "utf8");
    const walkthrough = loadWalkthroughText(source, file);
    // A placeholder in output-bound text is reported by the text check below, field by field.
    const inText = new Set(unresolvedDisplayText(walkthrough).map((u) => u.placeholder));
    const errors: ValidateError[] = unresolvedTemplatesIn(walkthrough)
      .filter((path) => !inText.has(path))
      .map((path) => ({
        message: `unresolved template placeholder {{${path}}}`,
        path,
      }));
    for (const message of emailValueProblems(walkthrough)) errors.push({ message, path: "steps" });
    for (const p of checkWalkthroughText(walkthrough, source)) {
      errors.push({
        message: `${p.step ? `step "${p.step}": ` : ""}${p.message} — "${p.text}"`,
        line: p.line,
        path: p.path,
        check: p.check,
        step: p.step,
        text: p.text,
      });
    }
    if (errors.length > 0) {
      return { file, ok: false, walkthrough: walkthrough.walkthrough, errors };
    }
    return { file, ok: true, walkthrough: walkthrough.walkthrough };
  } catch (err) {
    if (err instanceof WalkthroughValidationError) {
      return { file, ok: false, errors: err.errors };
    }
    // Any other failure (unreadable file, unexpected throw) — one short line, never a stack.
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { file, ok: false, errors: [{ message, path: "" }] };
  }
}

export function validatePath(target: string, opts: ValidateOptions = {}): ValidateResult[] {
  const results = findWalkthroughFiles(target).map(validateFile);
  // Across files: data states (needs/leaves/clears, cycles, {{run.*}} on screen); states/validate.ts.
  return applyStateChecks(markDuplicateIds(results), { target, states: opts.states, roles: opts.roles });
}

export function runValidate(target: string, json: boolean, opts: ValidateOptions = {}): number {
  let results: ValidateResult[];
  try {
    results = validatePath(target, opts);
  } catch (err) {
    // e.g. `target` doesn't exist — findWalkthroughFiles/statSync throws outside the
    // per-file try/catch. Report one short line instead of a raw stack, even with --json.
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) {
      console.log(JSON.stringify({ total: 0, invalid: 0, results: [], error: message }));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }

  const invalid = results.filter((r) => !r.ok);

  if (json) {
    console.log(JSON.stringify({ total: results.length, invalid: invalid.length, results }));
  } else if (results.length === 0) {
    console.log(`no walkthroughs found under ${target}`);
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`ok    ${r.file} (${r.walkthrough})`);
      } else {
        console.log(`fail  ${r.file}`);
        for (const e of r.errors ?? []) {
          console.log(`      ${e.line ? `line ${e.line}: ` : ""}${e.message}`);
        }
      }
      for (const w of r.warnings ?? []) {
        console.log(`      ${w.line ? `line ${w.line}: ` : ""}warning: ${w.message}`);
      }
    }
    console.log(`${results.length - invalid.length}/${results.length} walkthroughs valid`);
  }
  return invalid.length === 0 ? 0 : 1;
}
