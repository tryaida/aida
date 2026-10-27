// `aida validate` checks across walkthrough files for data states (decision 28): unknown state
// names, needs nothing provides, dependency cycles, unresolved templates in `setup.steps`, and
// `{{run.*}}` values that reach the screen or narration (they change every screenshot every run,
// which CI reports as churn; setup is the right place for them).
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Walkthrough } from "../walkthrough/index.js";
import { findUnresolvedTemplates, loadWalkthroughFile, personaRole, yamlLineLocator } from "../walkthrough/index.js";
import { bothNeedsAndLeaves, planCaptureRun } from "./order.js";
import { loadRunWalkthroughs } from "./run.js";

export interface StateProblem {
  file: string;
  walkthrough: string;
  level: "error" | "warning";
  message: string;
  /** Where in the file, e.g. `needs.0` or `steps.2.say`. */
  path: string;
}

export interface CheckStatesOptions {
  /** Config `states`. Unset (no config given): state names can't be checked against it, so
   * needs nothing leaves and cycles are warnings rather than errors. */
  states?: Record<string, { setup?: unknown; check?: unknown; as?: string }>;
  /** Config `roles` (role -> reader-facing name). With the walkthroughs' own personas, the known
   * roles that `setup.as` and a state's `as` are checked against. */
  roles?: Record<string, unknown>;
  /** Only report problems for these files (the rest are context, e.g. a single file's siblings). */
  reportFor?: Set<string>;
}

export function checkStates(entries: { file: string; walkthrough: Walkthrough }[], opts: CheckStatesOptions = {}): StateProblem[] {
  const problems: StateProblem[] = [];
  const left = new Set(entries.flatMap((e) => e.walkthrough.leaves ?? []));
  const configured = opts.states;
  const known = [...new Set([...left, ...Object.keys(configured ?? {})])].sort();
  const report = (e: { file: string; walkthrough: Walkthrough }, level: StateProblem["level"], path: string, message: string): void => {
    if (opts.reportFor && !opts.reportFor.has(e.file)) return;
    problems.push({ file: e.file, walkthrough: e.walkthrough.walkthrough, level, path, message });
  };

  // Roles `as:` may name: config `roles` plus every walkthrough's own persona. Unknown when neither
  // says anything, and then nothing is checked.
  const roles = new Set([...Object.keys(opts.roles ?? {}), ...entries.map((e) => personaRole(e.walkthrough.start)).filter((r): r is string => Boolean(r))]);
  const roleHint = (): string => `known roles: ${[...roles].sort().join(", ")}`;

  for (const e of entries) {
    const w = e.walkthrough;
    for (const [i, state] of (w.needs ?? []).entries()) {
      const stateAs = configured?.[state]?.as;
      if (stateAs && roles.size > 0 && !roles.has(stateAs)) {
        report(e, "warning", `needs.${i}`, `config states.${state}.as is ${stateAs}, which isn't a known role (${roleHint()}): its hooks would sign in as nobody this app knows`);
      }
      // A walkthrough is never its own provider: it needs the state before it runs.
      const leftByOther = entries.some((o) => o !== e && (o.walkthrough.leaves ?? []).includes(state));
      if (leftByOther) continue;
      const leavesItself = (w.leaves ?? []).includes(state);
      if (!configured) {
        report(
          e,
          "warning",
          `needs.${i}`,
          leavesItself
            ? `${bothNeedsAndLeaves(w.walkthrough, state)} (pass --config to check config states)`
            : `needs ${state}, which no walkthrough leaves: fine if config states gives it a setup or check hook (pass --config to check)`,
        );
      } else if (!(state in configured)) {
        report(e, "error", `needs.${i}`, leavesItself ? bothNeedsAndLeaves(w.walkthrough, state) : unknownState(state, known));
      } else if (!configured[state].setup && !configured[state].check) {
        report(
          e,
          "error",
          `needs.${i}`,
          leavesItself
            ? bothNeedsAndLeaves(w.walkthrough, state)
            : `needs ${state}, but nothing provides it: no walkthrough leaves it and config states.${state} has no setup or check hook`,
        );
      }
    }
    if (w.setup?.as && roles.size > 0 && !roles.has(w.setup.as)) {
      report(e, "warning", "setup.as", `setup.as is ${w.setup.as}, which isn't a known role (${roleHint()}): add it to config roles, or use a role a walkthrough signs in as`);
    }
    if (configured) {
      for (const [i, state] of (w.clears ?? []).entries()) {
        if (!left.has(state) && !(state in configured)) report(e, "error", `clears.${i}`, unknownState(state, known));
      }
    }

    if (w.setup) {
      const data = w.data ?? {};
      for (const path of new Set(findUnresolvedTemplates(w.setup.steps, data))) {
        report(e, "error", "setup.steps", `unresolved template placeholder {{${path}}} in setup steps`);
      }
    }
    for (const hit of runValuesOnScreen(w)) {
      report(
        e,
        "warning",
        hit.path,
        `{{run.*}} reaches the screen or narration here (${hit.what}${hit.via ? `, through data ${hit.via}` : ""}): it changes every run, so screenshots differ and CI reports them as changed each time; use run values in setup steps or hooks instead`,
      );
    }
  }

  // Cycles across every file. Missing providers are reported above with the file's own wording.
  const all = entries.map((e) => e.walkthrough);
  const plan = planCaptureRun(all, all, { states: configured }, {});
  for (const p of plan.problems) {
    if (p.kind !== "cycle") continue;
    for (const id of new Set(p.walkthroughs)) {
      const e = entries.find((x) => x.walkthrough.walkthrough === id);
      if (!e) continue;
      report(e, configured ? "error" : "warning", "needs", configured ? p.message : `${p.message} (unless config states gives one of them a setup hook)`);
    }
  }
  return problems;
}

function unknownState(state: string, known: string[]): string {
  const near = known.filter((k) => editDistance(k, state) <= 2);
  const hint = near.length > 0 ? `; did you mean ${near.join(" or ")}?` : known.length > 0 ? `; known states: ${known.join(", ")}` : "";
  return `unknown state ${state}: it isn't in config states and no walkthrough leaves it${hint}`;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

interface RunHit {
  path: string;
  what: string;
  /** The data path a `{{x.y}}` placeholder pulled the run value through. */
  via?: string;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Every visible or spoken field that ends up showing a `{{run.*}}` value, directly or through `data`. */
export function runValuesOnScreen(w: Walkthrough): RunHit[] {
  const tainted = runTaintedDataPaths(w.data ?? {});
  const hits: RunHit[] = [];
  const check = (value: unknown, path: string, what: string): void => {
    for (const text of stringsIn(value)) {
      for (const m of text.matchAll(PLACEHOLDER)) {
        const p = m[1];
        if (p.startsWith("run.")) {
          hits.push({ path, what });
          return;
        }
        const via = [...tainted].find((t) => t === p || t.startsWith(`${p}.`));
        if (via) {
          hits.push({ path, what, via: p });
          return;
        }
      }
    }
  };
  check(w.title, "title", "title");
  check(w.summary, "summary", "summary");
  for (const card of ["intro", "outro"] as const) check(w[card], card, card);
  const checkSteps = (steps: Walkthrough["steps"], prefix: string): void => {
    for (const [i, step] of steps.entries()) {
      for (const field of ["title", "say", "caption", "page_text"] as const) check(step[field], `${prefix}.${i}.${field}`, field);
      check(step.callouts?.map((c) => c.label), `${prefix}.${i}.callouts`, "callout label");
      for (const a of step.actions) {
        if (a.do === "type") check(a.text, `${prefix}.${i}`, "typed text");
        if (a.do === "select") check(a.option, `${prefix}.${i}`, "chosen option");
        // A target found by a run value means that value is on screen in the screenshot.
        if ("target" in a) check(a.target, `${prefix}.${i}`, "an on-screen element it finds");
      }
    }
  };
  checkSteps(w.steps, "steps");
  // Other ways in (decision 34) are captured and shown on the page too.
  for (const [i, path] of (w.paths ?? []).entries()) {
    check([path.title, path.when, path.note], `paths.${i}`, "path title, when or note");
    checkSteps(path.steps, `paths.${i}.steps`);
  }
  return hits;
}

/** Dotted data paths whose value (a string) contains a `{{run.*}}` placeholder. */
function runTaintedDataPaths(data: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (/\{\{\s*run\./.test(value)) out.add(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}.${i}`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(data, "");
  return out;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  return [];
}

interface ValidateEntry {
  message: string;
  path: string;
  line?: number;
}

/**
 * `aida validate`'s cross-file pass: adds state problems to per-file results (errors make a
 * file fail, warnings don't). When `target` is a single file, the other walkthroughs in its
 * directory are read as context (who leaves what) but only that file is reported on.
 */
export function applyStateChecks<R extends { file: string; ok: boolean; errors?: ValidateEntry[]; warnings?: ValidateEntry[] }>(
  results: R[],
  opts: { target: string; states?: CheckStatesOptions["states"]; roles?: CheckStatesOptions["roles"] },
): R[] {
  const entries: { file: string; walkthrough: Walkthrough }[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    try {
      entries.push({ file: r.file, walkthrough: loadWalkthroughFile(r.file) });
    } catch {
      // already reported by the per-file pass
    }
  }
  let reportFor: Set<string> | undefined;
  try {
    if (statSync(opts.target).isFile()) {
      reportFor = new Set(results.map((r) => r.file));
      const ids = new Set(entries.map((e) => e.walkthrough.walkthrough));
      for (const sibling of loadRunWalkthroughs(dirname(opts.target))) {
        if (!ids.has(sibling.walkthrough.walkthrough)) entries.push(sibling);
      }
    }
  } catch {
    // target vanished between passes: nothing extra to read
  }

  const problems = checkStates(entries, { states: opts.states, roles: opts.roles, reportFor });
  if (problems.length === 0) return results;
  const lineOf = new Map<string, (path: (string | number)[]) => number | undefined>();
  return results.map((r) => {
    const mine = problems.filter((p) => p.file === r.file);
    if (mine.length === 0) return r;
    if (!lineOf.has(r.file)) lineOf.set(r.file, yamlLineLocator(readFileSync(r.file, "utf8")));
    const locate = lineOf.get(r.file)!;
    const toEntry = (p: StateProblem): ValidateEntry => {
      const line = locate(p.path.split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)));
      return { message: p.message, path: p.path, ...(line ? { line } : {}) };
    };
    const errors = mine.filter((p) => p.level === "error").map(toEntry);
    const warnings = mine.filter((p) => p.level === "warning").map(toEntry);
    return {
      ...r,
      ...(errors.length > 0 ? { ok: false, errors: [...(r.errors ?? []), ...errors] } : {}),
      ...(warnings.length > 0 ? { warnings: [...(r.warnings ?? []), ...warnings] } : {}),
    };
  });
}
