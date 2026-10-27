// Works out a walkthrough target for an element the person clicked, typed into or picked.
//
// Candidates come in the order an author would write them (cheatsheet "Targets"): a form control
// by its label, then role + accessible name, then placeholder or visible text, CSS last. Each is
// checked with `locateAll`/`locate` from capture/locate.ts, the resolver a replay will use, and
// kept only when it finds this very element. A candidate that matches several elements is scoped
// with `within` the nearest named container, then with `nth`. When the element is already gone (a
// click that navigated before Node got to look), the page's own description is used unchecked and
// the target is marked unverified, so the draft says so and the replay after recording shows it.
import type { Locator, Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import { locate, locateAll } from "../capture/locate.js";
import { shortLabelText } from "../capture/label-text.js";
import type { ElementInfo, ResolvedTarget } from "./types.js";

/** Roles whose element is something to fill in or choose, found by its label first. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "spinbutton", "slider"]);
/** Roles an accessibility snapshot reports that don't make a useful role target on their own. */
const WEAK_ROLES = new Set(["generic", "text", "paragraph", "none", "presentation", "group", "list", "img", "document"]);
/** Container roles a `within` can be scoped to. */
const CONTAINER_ROLES = new Set(["dialog", "alertdialog", "group", "region", "form", "navigation", "complementary", "row", "listitem", "tabpanel", "menu"]);
const NAME_CAP = 80;

const markerSelector = (marker: string): string => `[data-aida-rec="${marker.replace(/["\\]/g, "")}"]`;

/** Role and accessible name exactly as Playwright's accessibility tree has them — the same tree
 * `getByRole` matches against. `undefined` when the element is gone or has no role of its own. */
export async function ariaRoleAndName(page: Page, marker: string): Promise<{ role: string; name?: string } | undefined> {
  let snapshot: string;
  try {
    snapshot = await page.locator(markerSelector(marker)).ariaSnapshot({ timeout: 1_000 });
  } catch {
    return undefined;
  }
  return parseSnapshotHead(snapshot);
}

/** Parses the first line of an aria snapshot (`- button "Save"`, `- textbox "Email": a@b`). */
export function parseSnapshotHead(snapshot: string): { role: string; name?: string } | undefined {
  const first = snapshot.split("\n")[0] ?? "";
  const m = first.match(/^- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/);
  if (!m) return undefined;
  let name: string | undefined;
  if (m[2]) {
    try {
      name = JSON.parse(m[2]) as string;
    } catch {
      name = m[2].slice(1, -1);
    }
  }
  return { role: m[1], ...(name ? { name } : {}) };
}

/** True when `loc` (one element) is the marked element, or inside it (a click there lands on it). */
async function isMarked(loc: Locator, marker: string, kind: "act" | "see"): Promise<boolean> {
  try {
    return await loc.evaluate(
      (el, { marker, kind }) => {
        const marked = document.querySelector(`[data-aida-rec="${marker}"]`);
        if (!marked) return false;
        if (el === marked || marked.contains(el)) return true;
        return kind === "see" && el.contains(marked);
      },
      { marker, kind },
      { timeout: 1_000 },
    );
  } catch {
    return false;
  }
}

/** The bare candidates for an element, best first. */
function candidates(el: ElementInfo, aria: { role: string; name?: string } | undefined, kind: "act" | "see"): Target[] {
  const out: Target[] = [];
  const role = aria?.role ?? el.role ?? el.implicitRole;
  const name = aria ? aria.name : el.name;
  const label = shortLabelText(el.labelDirect ?? "") || shortLabelText(el.labelFull ?? "");
  const byRole = role && name && !WEAK_ROLES.has(role) && name.length <= NAME_CAP ? { role, name } : undefined;
  const isField = role !== undefined && FIELD_ROLES.has(role);

  if (isField && label) out.push({ label });
  if (byRole) out.push(byRole);
  if (el.placeholder) out.push({ placeholder: el.placeholder });
  if (!isField && el.text && el.text.length <= NAME_CAP) out.push({ text: el.text });
  if (kind === "see" && byRole === undefined && name && name.length <= NAME_CAP && name !== el.text) out.push({ text: name });
  if (el.css) out.push({ css: el.css });
  return out;
}

/** Scopes for a candidate that matched more than one element: each named container, nearest first. */
async function containerTargets(page: Page, el: ElementInfo): Promise<Target[]> {
  const out: Target[] = [];
  for (const c of el.containers ?? []) {
    const aria = await ariaRoleAndName(page, c.marker);
    const role = aria?.role ?? c.role;
    const name = aria?.name ?? c.name;
    if (!role || !CONTAINER_ROLES.has(role)) continue;
    if (name && name.length <= NAME_CAP) out.push({ role, name });
  }
  return out;
}

async function count(target: Target, page: Page): Promise<number> {
  try {
    return await (await locateAll(target, page)).count();
  } catch {
    return 0;
  }
}

/** True when `target`, as a replay would resolve it, lands on the marked element. */
async function lands(target: Target, page: Page, marker: string, kind: "act" | "see"): Promise<boolean> {
  try {
    return await isMarked(await locate(target, page), marker, kind);
  } catch {
    return false;
  }
}

/** Index of the marked element among a target's matches, for `nth`. */
async function indexAmong(target: Target, page: Page, marker: string, kind: "act" | "see"): Promise<number | undefined> {
  try {
    const all = await locateAll(target, page);
    const n = Math.min(await all.count(), 20);
    for (let i = 0; i < n; i++) if (await isMarked(all.nth(i), marker, kind)) return i;
  } catch {
    // gone
  }
  return undefined;
}

/** Short words naming the element, for step titles and narration placeholders. */
export function wordsFor(target: Target): string {
  if (target.name) return target.name;
  if (target.label) return target.label;
  if (target.placeholder) return target.placeholder;
  if (target.text) return target.text;
  return "this";
}

/** The page's own description, unchecked: for an element that's already gone. */
export function unverifiedTarget(el: ElementInfo, kind: "act" | "see"): ResolvedTarget {
  const target = candidates(el, undefined, kind)[0] ?? { css: el.tag };
  return { target, verified: false, role: el.role ?? el.implicitRole, words: wordsFor(target) };
}

/**
 * Picks the first candidate that a replay would resolve to this element, trying it alone, then
 * with `exact: true` (role names match as substrings otherwise), then `within` each named
 * container, then `nth`.
 */
export async function resolveTarget(page: Page, el: ElementInfo, kind: "act" | "see" = "act"): Promise<ResolvedTarget> {
  const aria = await ariaRoleAndName(page, el.marker);
  // Gone already, or never had a box: describe it from what the page sent.
  if (!aria && (await page.locator(markerSelector(el.marker)).count().catch(() => 0)) === 0) return unverifiedTarget(el, kind);
  const role = aria?.role ?? el.role ?? el.implicitRole;
  const list = candidates(el, aria, kind);
  let scopes: Target[] | undefined;

  for (const base of list) {
    const tries: Target[] = [base];
    if (base.name || base.label || base.text) tries.push({ ...base, exact: true });
    for (const t of tries) {
      if ((await count(t, page)) === 1 && (await lands(t, page, el.marker, kind))) return done(t, true, role);
    }
    if (base.css) continue;
    scopes ??= await containerTargets(page, el);
    for (const within of scopes) {
      for (const t of tries) {
        const scoped = { ...t, within };
        if ((await count(scoped, page)) === 1 && (await lands(scoped, page, el.marker, kind))) return done(scoped, true, role);
      }
    }
    const nth = await indexAmong(base, page, el.marker, kind);
    if (nth !== undefined) {
      const t = nth === 0 ? base : { ...base, nth };
      if (await lands(t, page, el.marker, kind)) return done(t, true, role);
    }
  }
  const fallback = unverifiedTarget(el, kind);
  return { ...fallback, role: role ?? fallback.role };
}

function done(target: Target, verified: boolean, role: string | undefined): ResolvedTarget {
  return { target, verified, ...(role ? { role } : {}), words: wordsFor(target) };
}
