import type { Locator, Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import type { Box, Point } from "./types.js";
import { shortLabelText, stripHintMarkers } from "./label-text.js";

/**
 * Builds a Playwright locator from a Target matching every visible element,
 * matching the original pipeline's `locate()` before its first/last narrowing. Exported so
 * callers that need *every* match (e.g. masking) aren't stuck with the single
 * element `locate()` narrows down to.
 *
 * Async because a `label` target without an explicit `exact` may need to
 * look at the page to decide whether the exact match exists — see
 * `resolveLabel` below.
 */
export async function locateAll(desc: Target, root: Page | Locator): Promise<Locator> {
  if (!desc || typeof desc !== "object") {
    throw new Error(`bad target ${JSON.stringify(desc)}`);
  }
  const base: Page | Locator = desc.within ? await locate(desc.within, root) : root;
  let loc: Locator;
  const textArg = (t: string): string | RegExp => (/^\/.*\/$/.test(t) ? new RegExp(t.slice(1, -1)) : t);

  if (desc.role) {
    loc = base.getByRole(desc.role as Parameters<Page["getByRole"]>[0], {
      ...(desc.name ? { name: desc.name } : {}),
      exact: desc.exact ?? false,
    });
    // `text` alongside `role` isn't a second way to name the element (that's `name`) — it's a
    // hasText-style filter, same as the explicit `hasText` field below, for narrowing a
    // role/name match that still returns more than one element (e.g. role: row, text: a cell's
    // contents). Keeping it a filter rather than an alternate locator means `role` always wins
    // the *lookup*; `text` only narrows what `role` already found.
    if (desc.text) loc = loc.filter({ hasText: textArg(desc.text) });
  } else if (desc.label) {
    loc = await resolveLabel(base, desc.label, desc.exact);
  } else if (desc.placeholder) {
    loc = base.getByPlaceholder(desc.placeholder, { exact: true });
  } else if (desc.text) {
    loc = base.getByText(textArg(desc.text), { exact: desc.exact ?? false });
  } else if (desc.css) {
    loc = base.locator(desc.css);
  } else {
    throw new Error(`target needs role/label/placeholder/text/css: ${JSON.stringify(desc)}`);
  }
  if (desc.hasText) loc = loc.filter({ hasText: desc.hasText });
  return loc.filter({ visible: true });
}

/** Builds a Playwright locator from a Target, matching the original pipeline's `locate()`. `nth` (picking the
 * 0-based Nth of several role/name/etc matches — see `aida inspect`'s role+name duplicate
 * disambiguator, inspect/snapshot.ts's `collectDuplicateHints`) is applied last and takes
 * priority over `innermost` when both are set, since it names a specific element rather than a
 * position-in-nesting preference. */
export async function locate(desc: Target, root: Page | Locator): Promise<Locator> {
  const loc = await locateAll(desc, root);
  if (typeof desc.nth === "number") return loc.nth(desc.nth);
  return desc.innermost ? loc.last() : loc.first();
}

/** A `<label>`'s own text, with any control it wraps (and that control's rendered content) removed first. */
async function labelOwnText(labelEl: Locator): Promise<string> {
  return labelEl.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const control of clone.querySelectorAll("select, input, textarea, [role]")) control.remove();
    return clone.textContent ?? "";
  });
}

/** A `<label>`'s own *direct* text nodes only — not the text of any nested element, control or
 * not. This is what makes a hint nested in a child element (`<label>Address <span>Optional</span>
 * </label>`) invisible to the short name, without needing to know in advance what kind of element
 * carries the hint (a `<span>`, a badge, an icon with `aria-label`, anything). */
async function labelDirectText(labelEl: Locator): Promise<string> {
  return labelEl.evaluate((el) => {
    let text = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3 /* Node.TEXT_NODE */) text += `${n.textContent ?? ""} `;
    });
    return text;
  });
}

/** The short name `aida inspect` should print, and a `label` target's tier-2 match should use,
 * for one `<label>` element: its own direct text (see `labelDirectText`), falling back to its
 * full own text (sans wrapped controls) when the label's only text lives inside a nested element
 * (`<label><span>Email</span></label>` — direct text is empty, so there's nothing to fall back
 * past). Either way, run through `shortLabelText` for the final whitespace/trailing-marker
 * cleanup. */
async function shortNameOfLabel(labelEl: Locator): Promise<string> {
  const direct = shortLabelText(await labelDirectText(labelEl).catch(() => ""));
  if (direct) return direct;
  return shortLabelText(await labelOwnText(labelEl).catch(() => ""));
}

function throwAmbiguous(label: string, matches: { text: string }[]): never {
  const candidates = matches.slice(0, 5).map((m) => JSON.stringify(m.text));
  throw new Error(
    `label ${JSON.stringify(label)} is ambiguous: ${matches.length} candidates match, e.g. ${candidates.join(", ")}`,
  );
}

/**
 * Resolves a `label` target in three tiers, in order:
 *  1. Playwright's exact `getByLabel` (the historical, strict default) — the full accessible
 *     name equals `label` verbatim.
 *  2. Short-name equality: the label's own *direct* text (see `shortNameOfLabel`) equals `label`,
 *     once both are whitespace-normalised and stripped of a trailing `*`/`:`. This is what makes
 *     a hint *nested in a child element* (`<label>Address <span>Optional</span></label>`,
 *     `<label>What it was <span>Required for this action</span></label>`) invisible to the
 *     match — the hint's text was never a direct text node to begin with.
 *  3. The historical marker-stripped full-token match: the label's full own text (sans wrapped
 *     controls), once whitespace-normalised and stripped of inline "(Required...)"/"(Optional)"
 *     hint text and a trailing `*`/`:`, equals `label`. This is what matches a hint that's
 *     inline text on the label itself rather than a nested element.
 * Both tiers 2 and 3 require a *full-token* match — "Name" must never match "Name of club" (extra
 * *words*, not a hint marker, don't count). Ambiguity within a tier fails, listing candidates.
 * Explicit `exact: true` always keeps tier 1 only, the strict original-pipeline-compatible behaviour.
 */
async function resolveLabel(base: Page | Locator, label: string, exact: boolean | undefined): Promise<Locator> {
  if (exact === true) return base.getByLabel(label, { exact: true });

  const exactLoc = base.getByLabel(label, { exact: true });
  const exactCount = await exactLoc.count().catch(() => 0);
  if (exactCount > 0) return exactLoc;

  const wantedShort = shortLabelText(label).toLowerCase();
  const wantedFull = stripHintMarkers(label).toLowerCase();

  const labelEls = base.locator("label");
  const total = await labelEls.count().catch(() => 0);
  const records: { text: string; short: string; full: string; control: Locator }[] = [];
  for (let i = 0; i < total; i++) {
    const labelEl = labelEls.nth(i);
    // The label's *own* text, excluding anything contributed by a control it wraps — a wrapped
    // `<select>` renders its current option's text inline as part of the label's `innerText`
    // (unlike `<input>`, which never does), so comparing against the raw innerText would make
    // "Customer" permanently fail to match `<label>Customer <select>…Acme</select></label>` once
    // a real option's text got appended. Excluding the control's own subtree sidesteps that
    // without loosening the match to accept arbitrary extra words.
    const rawText = await labelOwnText(labelEl).catch(() => "");
    if (!rawText.trim()) continue;
    const control = await controlForLabel(base, labelEl);
    if (!control) continue;
    const short = await shortNameOfLabel(labelEl);
    const full = stripHintMarkers(rawText);
    records.push({ text: rawText.trim(), short, full, control });
  }

  const shortMatches = records.filter((r) => r.short.toLowerCase() === wantedShort && wantedShort);
  if (shortMatches.length === 1) return shortMatches[0].control;
  if (shortMatches.length > 1) throwAmbiguous(label, shortMatches);

  // Full-token match only, after hint markers are already stripped — "Name" must match "Name *"
  // and "Name (Required)" (both normalize down to "Name") but never "Name of club" (normalizes to
  // itself, unequal to "Name").
  const fullMatches = records.filter((r) => r.full.toLowerCase() === wantedFull && wantedFull);
  if (fullMatches.length === 1) return fullMatches[0].control;
  if (fullMatches.length > 1) throwAmbiguous(label, fullMatches);

  // No fallback match either — return the (empty) exact locator so the usual
  // "not found"/timeout error surfaces from the caller, unchanged.
  return exactLoc;
}

/**
 * The form control a `<label>` element labels: via `for=`/`label.control` (same thing — `for=` is
 * what makes `.control` resolve), via a control that points back at the label with
 * `aria-labelledby`, or the first control it wraps. Wrapped lookup prefers a real form control
 * (input/select/textarea) over a `[role]` element — a decorative icon
 * (`<label>Name <svg role="img"/><input/></label>`) must never win the match just because it
 * comes first in DOM order.
 */
async function controlForLabel(base: Page | Locator, labelEl: Locator): Promise<Locator | null> {
  const forId = await labelEl.getAttribute("for").catch(() => null);
  if (forId) {
    const loc = base.locator(`#${cssEscapeIdent(forId)}`);
    if ((await loc.count().catch(() => 0)) > 0) return loc.first();
  }

  const labelId = await labelEl.getAttribute("id").catch(() => null);
  if (labelId) {
    const loc = base.locator(`[aria-labelledby~="${labelId.replace(/"/g, '\\"')}"]`);
    if ((await loc.count().catch(() => 0)) > 0) return loc.first();
  }

  const formControl = labelEl.locator("input, select, textarea");
  if ((await formControl.count().catch(() => 0)) > 0) return formControl.first();

  const roleControl = labelEl.locator("[role]");
  if ((await roleControl.count().catch(() => 0)) > 0) return roleControl.first();

  return null;
}

/** Minimal CSS.escape-alike for element ids used in attribute selectors (no browser context here). */
function cssEscapeIdent(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function round(b: { x: number; y: number; width?: number; height?: number; w?: number; h?: number }): Box {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.round(b.width ?? b.w ?? 0),
    h: Math.round(b.height ?? b.h ?? 0),
  };
}

/** Resolves a target's bounding box in CSS px, growing it to include `padUnion` when set. */
export async function boxOf(desc: Target, root: Page | Locator): Promise<Box> {
  const loc = await locate(desc, root);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no box for ${JSON.stringify(desc)}`);
  let box = round(b);
  if (desc.padUnion) {
    const padLoc = await locate(desc.padUnion, root);
    const ob = await padLoc.boundingBox();
    if (!ob) throw new Error(`no box for padUnion ${JSON.stringify(desc.padUnion)}`);
    const o = round(ob);
    const x = Math.min(box.x, o.x);
    const y = Math.min(box.y, o.y);
    box = { x, y, w: Math.max(box.x + box.w, o.x + o.w) - x, h: Math.max(box.y + box.h, o.y + o.h) - y };
  }
  return box;
}

export function center(box: Box): Point {
  return { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
}
