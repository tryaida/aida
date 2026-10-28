/** Thrown by `resolveTemplate`/`resolveTemplatesDeep` for a `{{path}}` that has no data. */
export class UnresolvedTemplateError extends Error {
  constructor(public readonly path: string) {
    super(`unresolved template placeholder "{{${path}}}" — no "${path}" in this walkthrough's data`);
    this.name = "UnresolvedTemplateError";
  }
}

/**
 * Resolves `{{path}}` placeholders against a walkthrough's `data` block,
 * e.g. `{{competitor.firstName}}` reads `data.competitor.firstName`.
 * Placeholders are left in walkthrough actions as authored — capture (M2)
 * calls this at run time, once real values are known.
 *
 * Throws `UnresolvedTemplateError` naming the path if a placeholder has no matching
 * data — left in place silently, it used to pass `{{x}}` straight through to clicks/fills
 * and fail confusingly downstream instead of at the source.
 */
export function resolveTemplate(text: string, data: unknown): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path: string) => {
    // `{{inbox.<key>}}` is read from an email during capture (`showEmail` `remember`), when the
    // action runs: left in place here.
    if (isEmailPath(path)) return whole;
    const value = getPath(data, path);
    if (value === undefined) {
      throw new UnresolvedTemplateError(path);
    }
    return String(value);
  });
}

/** Resolves every string field in a JSON-like value, recursively. */
export function resolveTemplatesDeep<T>(value: T, data: unknown): T {
  if (typeof value === "string") {
    return resolveTemplate(value, data) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplatesDeep(v, data)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplatesDeep(v, data);
    }
    return out as T;
  }
  return value;
}

/**
 * Finds every `{{path}}` placeholder in a JSON-like value that has no matching data, without
 * throwing — used by `validate` to report every unresolved template across a walkthrough in
 * one pass, rather than stopping at the first one.
 */
export function findUnresolvedTemplates(value: unknown, data: unknown): string[] {
  const unresolved: string[] = [];
  collectUnresolvedTemplates(value, data, unresolved);
  return unresolved;
}

function collectUnresolvedTemplates(value: unknown, data: unknown, out: string[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      const path = m[1];
      // `{{run.id}}` has no entry in `data`: capture fills it in (see `withRunValues`).
      if (isRunPath(path) || isEmailPath(path)) continue;
      if (getPath(data, path) === undefined) out.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUnresolvedTemplates(v, data, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectUnresolvedTemplates(v, data, out);
    }
  }
}

function getPath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

/** The `{{run.<key>}}` values capture fills in on every run (decision 28). */
export interface RunValues {
  /** Short id unique to one `aida capture`/`build`/`ci` run, shared by every walkthrough in it. */
  id: string;
}

const RUN_KEYS = new Set<string>(["id"]);

/** True for a placeholder path capture fills in itself, e.g. `run.id`. */
export function isRunPath(path: string): boolean {
  const [head, key, ...rest] = path.split(".");
  return head === "run" && key !== undefined && RUN_KEYS.has(key) && rest.length === 0;
}

/** True for `{{inbox.<key>}}`: a value capture reads from an email a `showEmail` action showed
 * (its `remember`), filled in when a later action runs. */
export function isEmailPath(path: string): boolean {
  const [head, key, ...rest] = path.split(".");
  return head === "inbox" && Boolean(key) && rest.length === 0;
}

/** The `{{inbox.<key>}}` keys a string uses. */
export function emailKeysIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*inbox\.(\w+)\s*\}\}/g)].map((m) => m[1]);
}

/** `text` with `{{inbox.<key>}}` filled in from `values`; throws naming a key no email gave. */
export function fillEmailValues(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*inbox\.(\w+)\s*\}\}/g, (_whole, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`no {{inbox.${key}}} yet: an earlier showEmail must remember "${key}" (remember: { ${key}: "/pattern/" })`);
    return v;
  });
}

/**
 * A short id for one capture run: six lowercase letters and digits. Enough to tell this run's
 * "Morning session k3x9p2" apart from the last one's without crowding a form field.
 */
export function newRunId(): string {
  let id = "";
  while (id.length < 6) id += Math.random().toString(36).slice(2);
  return id.slice(0, 6);
}

/**
 * `data` ready for resolving a run's templates: `{{run.*}}` placeholders inside data's own
 * values filled in (so `name: "Morning {{run.id}}"` works when a step types `{{session.name}}`),
 * plus a `run` entry. Other placeholders are left for `resolveTemplate` to report.
 */
export function withRunValues(data: Record<string, unknown> | undefined, run: RunValues): Record<string, unknown> {
  const filled = fillRunPlaceholders(data ?? {}, run) as Record<string, unknown>;
  return { ...filled, run: { ...run } };
}

function fillRunPlaceholders(value: unknown, run: RunValues): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path: string) =>
      isRunPath(path) ? String(getPath({ run }, path)) : whole,
    );
  }
  if (Array.isArray(value)) return value.map((v) => fillRunPlaceholders(v, run));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fillRunPlaceholders(v, run);
    return out;
  }
  return value;
}
