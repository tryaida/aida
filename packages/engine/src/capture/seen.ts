// What a step really had on screen (`ManifestStep.seen`), for outline drift: the accessible name
// of each element an action resolved, and the page's h1-h3 headings. Unlike `targets` (the
// walkthrough's own search strings, see target-names.ts), these come from the live page, so a
// renamed button shows up as its new name. Deterministic: redacted, sorted, deduped, capped, and
// anything containing the run id (demo data made per run) is left out.
import type { Locator, Page } from "playwright";
import { redactSnapshot } from "./redact.js";

const NAME_CAP = 120;
const SEEN_CAP = 40;
const HEADING_CAP = 20;
/** Roles whose inline snapshot text is the field's value (possibly personal data), not a name. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox"]);

/** `- button "Save" [pressed]` -> `Save`; `- paragraph: Hello` -> `Hello`; a textbox's value never. */
export function nameFromAriaLine(line: string): string | undefined {
  const m = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]]*\])*(?::\s*(.*))?$/.exec(line);
  if (!m) return undefined;
  const [, role, quoted, inline] = m;
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1").trim() || undefined;
  if (inline === undefined || VALUE_ROLES.has(role)) return undefined;
  const text = inline.replace(/^"(.*)"$/, "$1").trim();
  return text || undefined;
}

/** The accessible name of the element `loc` resolved to, or undefined. Never throws. */
export async function accessibleName(loc: Locator): Promise<string | undefined> {
  const snapshot = await loc
    .first()
    .ariaSnapshot({ timeout: 1_000 })
    .catch(() => "");
  const first = snapshot.split("\n").find((l) => l.trim().length > 0);
  return first ? nameFromAriaLine(first) : undefined;
}

/** Visible h1-h3 (and `role=heading` levels 1-3) text, in page order. A plain source string:
 * see init-scripts.ts for why (`__name` under tsx). */
const HEADINGS_SCRIPT = `
(() => {
  var out = [];
  var els = document.querySelectorAll('h1, h2, h3, [role=heading][aria-level="1"], [role=heading][aria-level="2"], [role=heading][aria-level="3"]');
  for (var i = 0; i < els.length && out.length < ${HEADING_CAP}; i++) {
    var el = els[i];
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
})()
`;

export async function pageHeadings(page: Page): Promise<string[]> {
  return ((await page.evaluate(HEADINGS_SCRIPT).catch(() => [])) as string[]) ?? [];
}

/** `{ seen }` for a manifest step: redacted, without run-specific values, sorted, deduped, capped. */
export function seenField(names: Iterable<string | undefined>, runId: string): { seen?: string[] } {
  const out = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    if (runId && raw.includes(runId)) continue;
    const s = redactSnapshot(raw.replace(/\s+/g, " ").trim()).slice(0, NAME_CAP);
    if (s) out.add(s);
  }
  const seen = [...out].sort().slice(0, SEEN_CAP);
  return seen.length > 0 ? { seen } : {};
}
