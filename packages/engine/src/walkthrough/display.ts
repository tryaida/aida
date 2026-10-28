// Output-bound text with its `{{data}}` placeholders filled in (M35). Actions are resolved by
// capture at run time (template.ts); the words a reader sees or hears — page text, narration,
// captions, titles, callout labels, the title cards and each path's title/when/note — are resolved
// (and who the guide is `for`) here, once, against the walkthrough's own `data`, so pages, PDFs, the card, procedures, the
// search index, the help chat (which reads the pages), voice and the video all print the same
// words. `{{run.*}}` is never printed: it changes every run (states/validate.ts warns where it
// reaches the screen), so it is dropped from display text, directly or through a data value.
// A placeholder with no data is left as written; `aida validate` and the build's text check report
// it as an error (`unresolvedDisplayText`), so it never reaches a reader.
import type { Step, TitleCard, Walkthrough, WalkthroughPath } from "./types.js";
import { isEmailPath, isRunPath } from "./template.js";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
const RUN_PLACEHOLDER = /[ \t]*\{\{\s*run\.[\w.]+\s*\}\}/g;

function getPath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, data);
}

function dropRunValues(text: string): string {
  return text.replace(RUN_PLACEHOLDER, "").replace(/ {2,}/g, " ").trim();
}

/** A printable value for a data entry: strings with run values dropped; numbers and booleans as
 * written; objects/arrays (no sensible words) undefined. */
function printable(value: unknown): string | undefined {
  if (typeof value === "string") return dropRunValues(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** `text` with every `{{path}}` that names data filled in and `{{run.*}}` dropped; a placeholder
 * with no data is left as written (reported by validate). */
export function resolveDisplayText(text: string, data: Record<string, unknown> | undefined): string {
  if (!text.includes("{{")) return text;
  let dropped = false;
  const out = text.replace(PLACEHOLDER, (whole, path: string) => {
    if (path === "run" || path.startsWith("run.") || isEmailPath(path)) {
      dropped = true;
      return "";
    }
    const value = printable(getPath(data ?? {}, path));
    return value === undefined ? whole : value;
  });
  // Tidy the gap a dropped run value leaves ("Morning {{run.id}} session" -> "Morning session").
  return dropped ? out.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1").trim() : out;
}

function str<T extends string | undefined>(value: T, data: Record<string, unknown> | undefined): T {
  return (typeof value === "string" ? resolveDisplayText(value, data) : value) as T;
}

function card(c: TitleCard | undefined, data: Record<string, unknown> | undefined): TitleCard | undefined {
  if (!c) return c;
  return {
    ...c,
    eyebrow: str(c.eyebrow, data),
    title: str(c.title, data),
    subtitle: str(c.subtitle, data),
    say: str(c.say, data),
    caption: str(c.caption, data),
    ...(c.recap ? { recap: c.recap.map((r) => resolveDisplayText(r, data)) } : {}),
  };
}

function step(s: Step, data: Record<string, unknown> | undefined): Step {
  return {
    ...s,
    title: str(s.title, data),
    say: str(s.say, data),
    caption: str(s.caption, data),
    page_text: str(s.page_text, data),
    chapter: str(s.chapter, data),
    ...(s.callouts ? { callouts: s.callouts.map((c) => ({ ...c, label: str(c.label, data) })) } : {}),
  };
}

function path(p: WalkthroughPath, data: Record<string, unknown> | undefined): WalkthroughPath {
  return {
    ...p,
    title: resolveDisplayText(p.title, data),
    when: resolveDisplayText(p.when, data),
    note: str(p.note, data),
    steps: p.steps.map((s) => step(s, data)),
  };
}

const RESOLVED = Symbol.for("aida.displayResolved");

/**
 * `wt` with every output-bound text field resolved (see the module comment); actions, targets and
 * everything else untouched. Idempotent and cheap to call again: every output builder calls it on
 * the walkthrough it's handed.
 */
export function displayWalkthrough<T extends Walkthrough>(wt: T): T {
  if ((wt as unknown as Record<symbol, unknown>)[RESOLVED]) return wt;
  const data = wt.data;
  const out: T = {
    ...wt,
    title: resolveDisplayText(wt.title, data),
    summary: str(wt.summary, data),
    for: str(wt.for, data),
    intro: card(wt.intro, data),
    outro: card(wt.outro, data),
    steps: wt.steps.map((s) => step(s, data)),
    ...(wt.paths ? { paths: wt.paths.map((p) => path(p, data)) } : {}),
  };
  if (wt.intro === undefined) delete (out as Partial<Walkthrough>).intro;
  if (wt.outro === undefined) delete (out as Partial<Walkthrough>).outro;
  if (wt.for === undefined) delete (out as Partial<Walkthrough>).for;
  Object.defineProperty(out, RESOLVED, { value: true, enumerable: false });
  return out;
}

export interface UnresolvedDisplayText {
  /** YAML path of the field, e.g. "steps.2.page_text" or "paths.0.when". */
  path: string;
  /** Step id ("intro"/"outro" for the title cards, `<pathId>/<stepId>` for a path step). */
  step?: string;
  /** The placeholder's data path, e.g. "filter.status". */
  placeholder: string;
  /** The field exactly as written. */
  text: string;
}

/**
 * Every `{{path}}` in output-bound text that no data fills in (`{{run.*}}` excluded: it's dropped,
 * and states/validate.ts warns about it). A data value that isn't printable (an object or a list)
 * counts as unresolved too: it would print as `[object Object]`.
 */
export function unresolvedDisplayText(wt: Walkthrough): UnresolvedDisplayText[] {
  const data = wt.data ?? {};
  const out: UnresolvedDisplayText[] = [];
  const check = (text: string | undefined, path: string, stepId?: string) => {
    if (typeof text !== "string" || !text.includes("{{")) return;
    for (const m of text.matchAll(PLACEHOLDER)) {
      const p = m[1];
      if (isRunPath(p) || p === "run" || p.startsWith("run.") || isEmailPath(p)) continue;
      if (printable(getPath(data, p)) === undefined) out.push({ path, step: stepId, placeholder: p, text });
    }
  };
  check(wt.title, "title");
  check(wt.summary, "summary");
  check(wt.for, "for");
  for (const which of ["intro", "outro"] as const) {
    const c = wt[which];
    if (!c) continue;
    for (const f of ["eyebrow", "title", "subtitle", "say", "caption"] as const) check(c[f], `${which}.${f}`, which);
    c.recap?.forEach((r, i) => check(r, `${which}.recap.${i}`, which));
  }
  const checkSteps = (steps: Step[], prefix: string, idOf: (s: Step) => string | undefined) => {
    steps.forEach((s, i) => {
      for (const f of ["title", "say", "caption", "page_text", "chapter"] as const) check(s[f], `${prefix}.${i}.${f}`, idOf(s));
      s.callouts?.forEach((c, j) => check(c.label, `${prefix}.${i}.callouts.${j}.label`, idOf(s)));
    });
  };
  checkSteps(wt.steps, "steps", (s) => s.id);
  (wt.paths ?? []).forEach((p, i) => {
    check(p.title, `paths.${i}.title`);
    check(p.when, `paths.${i}.when`);
    check(p.note, `paths.${i}.note`);
    checkSteps(p.steps, `paths.${i}.steps`, (s) => (s.id ? `${p.id}/${s.id}` : undefined));
  });
  return out;
}

/** True when `text` still holds a `{{…}}` placeholder (a built output's last-line check). */
export function hasPlaceholder(text: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(text);
}
