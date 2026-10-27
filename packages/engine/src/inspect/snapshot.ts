// Browser-facing half of `aida inspect`: resolves the scan's scope (main landmark/open dialog
// by default, or `--area`) on an already-open, signed-in Playwright `Page` — opening the page
// and signing in is the CLI's job (commands/inspect.ts) — and turns Playwright's own
// `ariaSnapshot()` into the compact, token-cheap map an author needs. Deliberately reuses
// Playwright's accessible-name/role computation rather than re-deriving it: it's the same
// mapping Playwright's locator matching uses, so what this prints is what a walkthrough's
// `target: { role, name }` will actually match.
import type { Locator, Page } from "playwright";
import { formatSnapshot, normalizeName, INTERACTIVE_ROLE_RE } from "./format.js";
import type { FieldHint, DuplicateHint } from "./format.js";
import type { InspectResult, InspectScanOptions } from "./types.js";
import { maskSecretFieldValues, PASSWORD_VALUES_SCRIPT, stripQueryAndHash } from "../capture/redact.js";
import { REDACTED } from "./redact.js";

const LANDMARK_ROLE_NAMES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "region",
  "dialog",
  "alertdialog",
]);
const DIALOG_ROLES = ["dialog", "alertdialog"] as const;

/** Native HTML5 tag for a landmark role name, for landmarks that have one — a fallback for
 * `resolveArea` below, for pages where the element genuinely has the role but Playwright's
 * `getByRole` doesn't resolve it (e.g. an ancestor the role computation treats differently) even
 * though the tag/attribute is right there in the DOM. */
const LANDMARK_TAGS: Partial<Record<string, string>> = {
  main: "main",
  navigation: "nav",
  banner: "header",
  contentinfo: "footer",
  complementary: "aside",
  form: "form",
  dialog: "dialog",
  alertdialog: "dialog",
};

/** Resolves `--area` to a Locator: a known landmark role name (`main`, `navigation`, ...) tries,
 * in order, `getByRole` (the normal case), the landmark's native HTML5 tag if it has one, then a
 * `[role="..."]` attribute selector — so a page whose `<main>`/`[role=main]` element exists in
 * the DOM but doesn't resolve via `getByRole` for some reason still scopes correctly instead of
 * reporting "matched nothing". Anything that isn't a known landmark name is treated as a plain
 * CSS selector. */
async function resolveArea(page: Page, area: string): Promise<Locator> {
  if (!LANDMARK_ROLE_NAMES.has(area)) return page.locator(area).first();

  const byRole = page.getByRole(area as Parameters<Page["getByRole"]>[0]).first();
  if ((await byRole.count().catch(() => 0)) > 0) return byRole;

  const tag = LANDMARK_TAGS[area];
  if (tag) {
    const byTag = page.locator(tag).first();
    if ((await byTag.count().catch(() => 0)) > 0) return byTag;
  }

  const byAttr = page.locator(`[role="${area}"]`).first();
  if ((await byAttr.count().catch(() => 0)) > 0) return byAttr;

  // Nothing matched any strategy — return the role locator so the caller's "matched nothing"
  // error is accurate (its own `.count()` will be 0 too).
  return byRole;
}

/** Default scope: the `main` landmark if present (same three-strategy lookup `resolveArea` uses
 * for `--area main`), else `body` (still useful on a page that hasn't marked up a `<main>`). */
async function defaultRoot(page: Page): Promise<Locator> {
  const main = await resolveArea(page, "main");
  if ((await main.count().catch(() => 0)) > 0) return main;
  return page.locator("body");
}

async function openDialogSnapshot(page: Page): Promise<string | null> {
  for (const role of DIALOG_ROLES) {
    const loc = page.getByRole(role).filter({ visible: true });
    if ((await loc.count().catch(() => 0)) > 0) return loc.first().ariaSnapshot().catch(() => null);
  }
  return null;
}

/** Collects the normalised accessible-name-ish label of every required form control on the
 * page, best-effort: a control's own `<label>` text (same text `ariaSnapshot()` reports as its
 * accessible name for a simple label/for or wrapping label), else `aria-label`/`placeholder`/
 * `name`. Whole-document, not scope-limited — a field just outside `--area` still shouldn't be
 * silently reported as optional if the scope was drawn a little too tight. */
// Written as a plain source-text *string*, not a function — see capture/init-scripts.ts for
// why: under `npx tsx` (esbuild's "keep names for stack traces" transform), a named helper
// function nested inside a function passed to `page.evaluate()` gets rewritten to
// `const foo = __name((...) => {...}, "foo")`. `__name` is a helper tsx injects into the
// *compiled module*, not the browser realm Playwright serialises the callback's source text
// into — so the instant the nested `__name(...)` call (which ends up inside the outer
// function's own `.toString()`, since that reflects the transformed file's source range) runs
// on the page, it throws `ReferenceError: __name is not defined`. A plain string is never run
// through that transform (TypeScript/esbuild don't parse the *contents* of a string literal),
// so it reaches the browser byte-for-byte regardless of toolchain. Confirmed with a minimal
// repro: any named `const fn = (...) => {...}` nested inside a `page.evaluate()` callback
// reproduces this under tsx, even with no other tsx-specific code involved.
const COLLECT_REQUIRED_NAMES_SCRIPT = `
(() => {
  var out = [];
  var seen = new Set();
  function add(el, text) {
    if (seen.has(el)) return;
    seen.add(el);
    var trimmed = (text == null ? "" : text).replace(/\\s+/g, " ").trim();
    if (trimmed) out.push(trimmed);
  }
  function labelText(el) {
    if (el.labels && el.labels.length > 0) {
      return el.labels[0].textContent;
    }
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || null;
  }
  var selector = "[required], [aria-required='true']";
  var nodes = document.querySelectorAll(selector);
  for (var i = 0; i < nodes.length; i++) {
    add(nodes[i], labelText(nodes[i]));
  }
  return out;
})()
`;

async function collectRequiredNames(page: Page): Promise<Set<string>> {
  const names = (await page.evaluate(COLLECT_REQUIRED_NAMES_SCRIPT)) as string[];
  return new Set(names.map(normalizeName));
}

// Collects, for every `<label>` with an associated control, the "short name" an author should
// write as a walkthrough's `target: { label: ... }` plus a required/optional verdict — see
// capture/label-text.ts's header comment for why a label's *direct* text (as opposed to its full
// accessible name) is the short name, and the matching note on `labelDirectText` there. Written
// out again here, in full, as a plain source-text string rather than importing capture/
// label-text.ts's logic — `page.evaluate()` serialises whatever runs in the browser from source
// text, so there's no way to literally share the compiled function across the Node/browser
// boundary; see the `COLLECT_REQUIRED_NAMES_SCRIPT` comment above for why a *string* (not a
// function) is used at all. Keep in sync with capture/label-text.ts + locate.ts's
// `labelDirectText`/`labelOwnText`/`controlForLabel` by hand if either changes.
const COLLECT_FIELD_HINTS_SCRIPT = `
(() => {
  var out = [];
  function norm(s) { return (s == null ? "" : s).replace(/\\s+/g, " ").trim(); }
  function shortText(s) { return norm(s).replace(/[*:]+$/, "").trim(); }
  function stripHintMarkers(s) {
    return norm(s).replace(/\\(\\s*(required|optional)[^)]*\\)|[*:]+\\s*$/gi, " ").replace(/\\s+/g, " ").trim();
  }
  function ownText(label) {
    var clone = label.cloneNode(true);
    var controls = clone.querySelectorAll("select, input, textarea, [role]");
    for (var i = 0; i < controls.length; i++) controls[i].remove();
    return clone.textContent || "";
  }
  function directText(label) {
    var s = "";
    for (var i = 0; i < label.childNodes.length; i++) {
      var n = label.childNodes[i];
      if (n.nodeType === 3) s += (n.textContent || "") + " ";
    }
    return s;
  }
  function controlFor(label) {
    var forId = label.getAttribute("for");
    if (forId) {
      var byId = document.getElementById(forId);
      if (byId) return byId;
    }
    var labelId = label.getAttribute("id");
    if (labelId) {
      var byAria = document.querySelector('[aria-labelledby~="' + labelId + '"]');
      if (byAria) return byAria;
    }
    var formControl = label.querySelector("input, select, textarea");
    if (formControl) return formControl;
    var roleControl = label.querySelector("[role]");
    if (roleControl) return roleControl;
    return null;
  }

  var labels = document.querySelectorAll("label");
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    var control = controlFor(label);
    if (!control) continue;
    var raw = ownText(label);
    if (!norm(raw)) continue;
    var direct = directText(label);
    var short = shortText(direct) || shortText(raw);
    var full = stripHintMarkers(raw) || norm(raw);
    var required = null;
    if (control.hasAttribute("required") || control.getAttribute("aria-required") === "true") {
      required = true;
    } else if (/required/i.test(raw)) {
      required = true;
    } else if (/optional/i.test(raw)) {
      required = false;
    }
    out.push({ full: norm(raw), short: short, required: required });
  }
  return out;
})()
`;

async function collectFieldHints(page: Page): Promise<FieldHint[]> {
  return (await page.evaluate(COLLECT_FIELD_HINTS_SCRIPT)) as FieldHint[];
}

/** The nearest named group/fieldset/region/dialog/form ancestor of a Locator's element — the
 * disambiguator `aida inspect` prints for a role+name pair that repeats (see
 * `collectDuplicateHints` below). A real function, not a string passed to `.evaluate()` — unlike
 * `page.evaluate(someString)` (see `COLLECT_REQUIRED_NAMES_SCRIPT`'s header comment), Playwright's
 * `locator.evaluate()` doesn't thread an element into a string pageFunction (confirmed: it
 * silently resolves to `undefined` instead of binding `el`), so this has to be a real function —
 * which means avoiding the `__name` tsx bug a different way: no nested named function/const
 * bindings inside the callback (the bug is specifically about esbuild's "keep names" wrapping a
 * *named* function binding; an anonymous inline arrow passed straight to `.map()`, as used below,
 * is never given a name to keep). */
async function nearestNamedAncestorOf(loc: Locator): Promise<string | null> {
  return loc
    .evaluate((el) => {
      const NAMED_ROLES = new Set(["group", "region", "dialog", "alertdialog", "form"]);
      let cur: Element | null = el.parentElement;
      while (cur) {
        const explicitRole = cur.getAttribute("role");
        const role =
          explicitRole ??
          (cur.tagName === "FIELDSET" ? "group" : cur.tagName === "DIALOG" ? "dialog" : cur.tagName === "FORM" ? "form" : null);
        if (role && NAMED_ROLES.has(role)) {
          let name = cur.getAttribute("aria-label")?.trim() || null;
          if (!name) {
            const labelledby = cur.getAttribute("aria-labelledby");
            if (labelledby) {
              name =
                labelledby
                  .split(/\s+/)
                  .map((id) => document.getElementById(id)?.textContent ?? "")
                  .join(" ")
                  .replace(/\s+/g, " ")
                  .trim() || null;
            }
          }
          if (!name && cur.tagName === "FIELDSET") {
            name = cur.querySelector("legend")?.textContent?.trim() || null;
          }
          if (name) return name;
        }
        cur = cur.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

/** For every role+name pair that appears more than once in `snapshotText`, re-locates it live
 * (`root.getByRole(role, { name, exact: true })`) and records, for each occurrence in document
 * order, the nearest named group/fieldset/region/dialog/form ancestor's accessible name — the
 * disambiguator `aida inspect` prints so an author can write `within: { ... }` instead of a
 * brittle `nth`. Falls back to no `within` (the caller prints `nth: N` instead) when no such
 * ancestor has a name. Skipped entirely for a role+name whose live count doesn't match the
 * snapshot's count (can't be re-indexed reliably) or that resolves to just one element now (e.g.
 * the dialog text was included but is now closed). */
async function collectDuplicateHints(root: Page | Locator, snapshotText: string): Promise<DuplicateHint[]> {
  const counts = new Map<string, { role: string; name: string; count: number }>();
  for (const line of snapshotText.split("\n")) {
    const m = line.match(INTERACTIVE_ROLE_RE);
    if (!m) continue;
    const [, , role, name] = m;
    const key = `${role}\u0000${normalizeName(name).toLowerCase()}`;
    const rec = counts.get(key) ?? { role, name, count: 0 };
    rec.count += 1;
    counts.set(key, rec);
  }

  const hints: DuplicateHint[] = [];
  for (const { role, name, count } of counts.values()) {
    if (count < 2) continue;
    const loc = root
      .getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true })
      .filter({ visible: true });
    const actual = await loc.count().catch(() => 0);
    if (actual < 2) continue;
    for (let i = 0; i < actual; i++) {
      const within = await nearestNamedAncestorOf(loc.nth(i));
      hints.push({ role, name, index: i, within: within ?? undefined });
    }
  }
  return hints;
}

/** Runs one `aida inspect` scan against an already-open `Page`. */
export async function scanPage(page: Page, opts: InspectScanOptions = {}): Promise<InspectResult> {
  const root = opts.area ? await resolveArea(page, opts.area) : await defaultRoot(page);
  if ((await root.count().catch(() => 0)) === 0) {
    throw new Error(opts.area ? `--area "${opts.area}" matched nothing on this page` : "no main landmark or body found");
  }

  const rootSnapshot = await root.ariaSnapshot();
  const dialogSnapshot = await openDialogSnapshot(page);
  // Typed passwords, tokens and card numbers never reach the output (the aria snapshot prints a
  // textbox's live value, and doesn't say it's `type=password`).
  const passwords = (await page.evaluate(PASSWORD_VALUES_SCRIPT).catch(() => [])) as string[];
  const combined = maskSecretFieldValues(
    dialogSnapshot && !rootSnapshot.includes(dialogSnapshot) ? `${dialogSnapshot}\n${rootSnapshot}` : rootSnapshot,
    REDACTED,
    passwords,
  );

  const requiredNames = await collectRequiredNames(page);
  const hints = await collectFieldHints(page).catch(() => []);
  const duplicates = await collectDuplicateHints(root, combined).catch(() => []);
  const { text, lineCount, truncated } = formatSnapshot(combined, requiredNames, {
    lineCap: opts.lineCap,
    optionCap: opts.optionCap,
    hints,
    duplicates,
  });

  // No query or fragment (`#access_token=…`) and no opaque path segments, as in failure reports.
  return { url: stripQueryAndHash(page.url()), area: opts.area, snapshot: text, lineCount, truncated };
}
