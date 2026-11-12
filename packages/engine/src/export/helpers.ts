// Small functions written at the top of an exported spec, for what one Playwright locator or
// matcher can't say the way capture means it. Each is written only when the spec calls it, and
// `aida import playwright` reads a call to one back as the action it came from
// (walkthrough/playwright/), so the names and call shapes here are part of the round trip.
import { HINT_MARKER_RE } from "../capture/label-text.js";
import type { CodeContext } from "./code.js";

/** `(await aidaLabel(root, "Label"))`: a label target without `exact: true`. */
export const LABEL_HELPER = "aidaLabel";
/** `await aidaSelect(page, dropdown, "Option")`: a `select` action. */
export const SELECT_HELPER = "aidaSelect";
/** `expect.poll(() => aidaText(locator), ...)`: an element's text, whitespace collapsed. */
export const TEXT_HELPER = "aidaText";

/** How long `aidaLabel` waits for the label to be on the page: capture's wait for an expect. */
const LABEL_WAIT_MS = "20_000";

// capture/locate.ts `resolveLabel`, at run time: capture uses the hint fallback only when no exact
// label exists, so the spec has to look before it picks, and then count first/nth/last over the
// one set capture counts over. Mirrors `labelOwnText`, `labelDirectText`, `controlForLabel` and
// the two fallback tiers there, with label-text.ts's `shortLabelText` and `stripHintMarkers`.
const LABEL_CODE = String.raw`/**
 * A walkthrough's label target, found the way aida's capture finds it: the field with exactly that
 * label when the page has one; otherwise the one field whose label reads the same once a
 * required/optional hint is left out ("Email *", "Phone (Required)", "Address <span>Optional</span>").
 */
async function ${LABEL_HELPER}(root: Page | Locator, label: string): Promise<Locator> {
  const exact = root.getByLabel(label, { exact: true });
  const deadline = Date.now() + ${LABEL_WAIT_MS};
  for (;;) {
    if ((await exact.count()) > 0) return exact;
    const hinted = await aidaHintedLabel(root, label);
    if (hinted || Date.now() >= deadline) return hinted ?? exact;
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function aidaHintedLabel(root: Page | Locator, label: string): Promise<Locator | undefined> {
  const short = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[*:]+$/, "").trim();
  const full = (text: string) => text.replace(${String(HINT_MARKER_RE)}, " ").replace(/\s+/g, " ").trim();
  const labels = root.locator("label");
  const texts = await labels.evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll("select, input, textarea, [role]").forEach((control) => control.remove());
      let direct = "";
      el.childNodes.forEach((node) => {
        if (node.nodeType === 3) direct += (node.textContent ?? "") + " ";
      });
      return { own: clone.textContent ?? "", direct };
    }),
  );
  const rows = texts
    .map((t, i) => ({ i, text: t.own.trim(), short: (short(t.direct) || short(t.own)).toLowerCase(), full: full(t.own).toLowerCase() }))
    .filter((row) => row.text !== "");
  for (const [tier, wanted] of [["short", short(label).toLowerCase()], ["full", full(label).toLowerCase()]] as const) {
    if (!wanted) continue;
    const found: { text: string; control: Locator }[] = [];
    for (const row of rows) {
      if (row[tier] !== wanted) continue;
      const control = await aidaLabelledControl(root, labels.nth(row.i));
      if (control) found.push({ text: row.text, control });
    }
    if (found.length > 1) {
      const some = found.slice(0, 5).map((f) => JSON.stringify(f.text)).join(", ");
      throw new Error("label " + JSON.stringify(label) + " is ambiguous: " + found.length + " candidates match, e.g. " + some);
    }
    if (found.length === 1) return found[0].control;
  }
  return undefined;
}

async function aidaLabelledControl(root: Page | Locator, labelEl: Locator): Promise<Locator | undefined> {
  const forId = await labelEl.getAttribute("for");
  if (forId) {
    const byFor = root.locator("#" + forId.replace(/([^a-zA-Z0-9_-])/g, "\\$1"));
    if ((await byFor.count()) > 0) return byFor.first();
  }
  const id = await labelEl.getAttribute("id");
  if (id) {
    const byRef = root.locator('[aria-labelledby~="' + id.replace(/"/g, '\\"') + '"]');
    if ((await byRef.count()) > 0) return byRef.first();
  }
  for (const css of ["input, select, textarea", "[role]"]) {
    const wrapped = labelEl.locator(css);
    if ((await wrapped.count()) > 0) return wrapped.first();
  }
  return undefined;
}`;

// capture/runner.ts's `select`: a native <select> by the option's label, else its value; a custom
// dropdown opened, the option clicked inside the listbox the trigger controls
// (`resolveComboboxListbox`), and the trigger checked to show it (`comboboxShowsOption`).
const SELECT_CODE = String.raw`/**
 * A walkthrough's select, done the way aida's capture does it: a native <select> takes the option
 * by its label (else its value); a custom dropdown is opened, the option clicked in the listbox it
 * controls (else the one visible listbox), and the dropdown must then show that option.
 */
async function ${SELECT_HELPER}(page: Page, dropdown: Locator, option: string): Promise<void> {
  const native = await dropdown.evaluate((el, wanted) => {
    if (el.tagName !== "SELECT") return undefined;
    return { byLabel: Array.from((el as HTMLSelectElement).options).some((o) => o.label === wanted) };
  }, option);
  if (native) {
    await dropdown.selectOption(native.byLabel ? { label: option } : option);
    return;
  }
  await dropdown.click();
  const trigger = await dropdown.elementHandle();
  const ref = ((await dropdown.getAttribute("aria-controls")) ?? (await dropdown.getAttribute("aria-owns")))?.split(/\s+/)[0];
  const owned = ref ? page.locator('[id="' + ref.replace(/"/g, '\\"') + '"]') : undefined;
  const listbox = owned && (await owned.count()) > 0 ? owned.first() : page.getByRole("listbox").filter({ visible: true }).first();
  await listbox.getByRole("option", { name: option, exact: true }).click({ timeout: 10_000 });
  const shown = await trigger?.evaluate((el, wanted) => ((el as HTMLInputElement).value ?? "").includes(wanted) || (el.textContent ?? "").includes(wanted), option);
  if (!shown) throw new Error("select: " + JSON.stringify(option) + " does not appear selected after clicking the option");
}`;

// capture/text-check.ts collapses whitespace before it tests a pattern; Playwright's text
// matchers only do that for a string, so a pattern is polled against this instead.
const TEXT_CODE = String.raw`/** An element's text with whitespace collapsed, as aida's capture reads it for a text check. */
async function ${TEXT_HELPER}(target: Locator): Promise<string> {
  return ((await target.textContent()) ?? "").replace(/\s+/g, " ").trim();
}`;

/** The helpers `ctx`'s code calls, in a fixed order, each followed by a blank line. */
export function helperCode(ctx: CodeContext): string[] {
  const out: string[] = [];
  if (ctx.helpers.has("label")) out.push(LABEL_CODE, "");
  if (ctx.helpers.has("select")) out.push(SELECT_CODE, "");
  if (ctx.helpers.has("text")) out.push(TEXT_CODE, "");
  return out;
}
