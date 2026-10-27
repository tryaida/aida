// `aida inspect --click "<name>"` opens a menu/dialog before scanning — e.g. so an author can
// see a combobox's listbox contents, or a kebab menu's items. `--check "<name>"` ticks a radio/
// checkbox for the same reason (revealing a field it conditionally shows).
//
// Read-only in practice, but not by refusing on name alone any more (bug: "Add mob" — a plain
// dialog opener — used to get refused just because its name contains "add", the same substring a
// real write-shaped "Add competitor" button would have). Safety now comes from two layers
// instead: a hard refusal for anything that's actually shaped like a submit control (role outside
// button/menuitem/tab, or `type="submit"`), and the network-level block commands/inspect.ts
// installs for the whole scan (every non-GET request aborted before it reaches the wire — see
// there). A write-shaped *name* is still surfaced, just as a `warning` on the outcome rather than
// a thrown refusal: useful context, not a reason to block a click that can't actually write
// anything regardless of what it's named.
import type { Locator, Page, Request } from "playwright";
import type { ClickOutcome } from "./types.js";

// `combobox` added so a custom combobox trigger (e.g. Radix's "Select competitor…", which marks
// its trigger `role="combobox"` rather than `role="button"`) can be opened the same way a plain
// button/menuitem/tab can — see the header comment above and `findClickTarget` below, which also
// catches a `role="button"` trigger that instead advertises itself via `aria-haspopup="listbox"`.
const ALLOWED_CLICK_ROLES = ["button", "menuitem", "tab", "combobox"] as const;
const ALLOWED_CHECK_ROLES = ["radio", "checkbox"] as const;
/** No longer a hard refusal — see header comment. Folded into `ClickOutcome.warning` instead. */
const WRITE_SHAPED_NAME_RE = /save|submit|delete|create|add|pay|send/i;
/** How long to wait, after the click, for either a dialog/listbox to appear or a blocked write
 * request to be observed, before giving up on both. */
const AFTER_CLICK_WAIT_MS = 1000;
/** Cap on printed listbox options, same as a native `<select>`'s option cap (inspect/format.ts's
 * default `optionCap`). */
const LISTBOX_OPTION_CAP = 15;

export class InspectClickRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectClickRefusedError";
  }
}

/** Resolves `name` to the first visible element with one of `roles`, or null. */
async function findByRole(page: Page, roles: readonly string[], name: string): Promise<Locator | null> {
  for (const role of roles) {
    const loc = page.getByRole(role as Parameters<Page["getByRole"]>[0], { name }).filter({ visible: true });
    if ((await loc.count().catch(() => 0)) > 0) return loc.first();
  }
  return null;
}

/** `--click`'s target resolution: one of `ALLOWED_CLICK_ROLES` by name (button/menuitem/tab/
 * combobox), or — the other shape a custom combobox trigger takes — a `role="button"` (already
 * covered above, kept here only for clarity) advertising a listbox popup via
 * `aria-haspopup="listbox"`. Both are allowed for the same reason: neither can ever submit
 * anything, and the network-level block in commands/inspect.ts is what actually prevents a
 * write, not this role check. */
async function findClickTarget(page: Page, name: string): Promise<Locator | null> {
  const byAllowedRole = await findByRole(page, ALLOWED_CLICK_ROLES, name);
  if (byAllowedRole) return byAllowedRole;

  // A trigger that only advertises its popup via `aria-haspopup="listbox"` without otherwise
  // being role=combobox (seen in the wild on some non-Radix custom-select implementations) —
  // check every visible, named element for the attribute rather than trusting a specific role.
  const byName = page.getByText(name).filter({ visible: true });
  const count = await byName.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 10); i++) {
    const el = byName.nth(i);
    const haspopup = await el.getAttribute("aria-haspopup").catch(() => null);
    if (haspopup === "listbox") return el;
  }
  return null;
}

/** Collects a visible listbox's option texts (capped at `LISTBOX_OPTION_CAP`), then closes it
 * with Escape — mirrors how a native `<select>` is never left open after inspect looks at it. */
async function collectAndCloseListbox(page: Page): Promise<{ options: string[]; truncated: boolean } | null> {
  const listbox = page.getByRole("listbox").filter({ visible: true }).first();
  const opened = await listbox
    .waitFor({ state: "visible", timeout: AFTER_CLICK_WAIT_MS })
    .then(() => true)
    .catch(() => false);
  if (!opened) return null;

  const optionLocs = listbox.getByRole("option").filter({ visible: true });
  const total = await optionLocs.count().catch(() => 0);
  const options: string[] = [];
  for (let i = 0; i < Math.min(total, LISTBOX_OPTION_CAP); i++) {
    const text = await optionLocs.nth(i).innerText().catch(() => "");
    if (text.trim()) options.push(text.trim());
  }
  await page.keyboard.press("Escape").catch(() => {});
  return { options, truncated: total > LISTBOX_OPTION_CAP };
}

/**
 * Clicks the first button/menuitem/tab named `name` to open a menu or dialog before scanning.
 * Refuses (without clicking) a name that doesn't resolve to one of those three roles, or that
 * resolves to a `type="submit"` control — inspect never submits a form, full stop. Everything
 * else is allowed: the network-level block (see commands/inspect.ts) is what actually keeps a
 * write from happening, not a guess about what the element's name sounds like.
 */
export async function clickToOpen(page: Page, name: string): Promise<ClickOutcome> {
  const target = await findClickTarget(page, name);
  if (!target) {
    throw new InspectClickRefusedError(
      `refusing --click "${name}" — no visible button/menuitem/tab/combobox with that name (inspect only ever clicks one of those roles, or an aria-haspopup="listbox" trigger)`,
    );
  }

  const type = await target.getAttribute("type").catch(() => null);
  if (type === "submit") {
    throw new InspectClickRefusedError(`refusing --click "${name}" — type="submit" (inspect never submits a form)`);
  }

  let blockedWrite = false;
  const onRequest = (req: Request): void => {
    if (req.method() !== "GET") blockedWrite = true;
  };
  page.on("request", onRequest);
  try {
    await target.click();
    const dialogOpened = await page
      .getByRole("dialog")
      .or(page.getByRole("alertdialog"))
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: AFTER_CLICK_WAIT_MS })
      .then(() => true)
      .catch(() => false);
    const listbox = dialogOpened ? null : await collectAndCloseListbox(page);
    // Give a fired-but-blocked write request a moment to be observed even when neither a dialog
    // nor a listbox showed up (the three aren't mutually exclusive, but only one needs to happen
    // for the click to have told us something useful).
    if (!dialogOpened && !listbox) await page.waitForTimeout(250);
    const warning = WRITE_SHAPED_NAME_RE.test(name)
      ? `"${name}" looks write-shaped by name — non-GET requests are blocked for the whole inspect scan, so nothing was actually sent`
      : undefined;
    return {
      dialogOpened,
      blockedWrite,
      warning,
      ...(listbox ? { listboxOptions: listbox.options, listboxTruncated: listbox.truncated } : {}),
    };
  } finally {
    page.off("request", onRequest);
  }
}

/**
 * `--select "<field>" "<option>"`: picks `option` in the control named `field`, native `<select>`
 * or custom combobox/listbox alike — so an author can reveal a conditional field that only
 * appears once a particular choice is made (e.g. a "Select competitor…" Radix combobox),
 * without that being a real write: a native select's `selectOption` never submits anything by
 * itself, and a custom combobox is driven by clicking its trigger then its option — both already
 * inert for non-GET requests via commands/inspect.ts's network-level block, same as `--click`.
 */
export async function selectOption(page: Page, field: string, option: string): Promise<void> {
  const nativeSelect = page.getByLabel(field).filter({ visible: true });
  if ((await nativeSelect.count().catch(() => 0)) > 0) {
    const tagName = await nativeSelect.first().evaluate((el) => el.tagName).catch(() => null);
    if (tagName === "SELECT") {
      await nativeSelect.first().selectOption({ label: option });
      return;
    }
  }

  const trigger = await findClickTarget(page, field);
  if (!trigger) {
    throw new InspectClickRefusedError(
      `refusing --select "${field}" — no visible <select>/combobox/listbox trigger with that name`,
    );
  }
  await trigger.click();
  const listboxOption = page.getByRole("listbox").getByRole("option", { name: option }).filter({ visible: true }).first();
  const found = await listboxOption
    .waitFor({ state: "visible", timeout: AFTER_CLICK_WAIT_MS })
    .then(() => true)
    .catch(() => false);
  if (!found) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new InspectClickRefusedError(`refusing --select "${field}" "${option}" — no visible option with that name after opening it`);
  }
  await listboxOption.click();
}

/** Checks (ticks) the first visible radio/checkbox named `name`, to reveal any field it
 * conditionally shows before scanning. Refuses a name that doesn't resolve to a visible
 * radio/checkbox. */
export async function checkToReveal(page: Page, name: string): Promise<void> {
  const target = await findByRole(page, ALLOWED_CHECK_ROLES, name);
  if (!target) {
    throw new InspectClickRefusedError(
      `refusing --check "${name}" — no visible radio/checkbox with that name`,
    );
  }
  await target.check();
}
