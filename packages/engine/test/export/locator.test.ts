// An exported spec's locators find the element capture/locate.ts finds: each target form is
// resolved both ways on the same page and must land on the same element.
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locate } from "../../src/capture/locate.js";
import type { Target } from "../../src/walkthrough/index.js";
import { exportedLocator } from "./run-spec.js";

const FIXTURE = `<!doctype html>
<html><body><main>
  <button style="display:none">Save</button>
  <button id="save-main">Save</button>
  <button id="save-all">Save all</button>
  <div role="dialog" aria-label="New">
    <button id="save-dialog">Save</button>
    <label>Title <input id="dialog-title"></label>
  </div>
  <label for="email">Email *</label><input id="email">
  <label>Address <span>Optional</span><input id="address"></label>
  <label>Phone (Required for this action) <input id="phone"></label>
  <label>Club <input id="club"></label>
  <label>Club name <input id="club-name"></label>
  <input placeholder="Search all" id="search-all"><input placeholder="Search" id="search">
  <p id="total-3">Total: 3</p><p id="total-30">Total: 30</p>
  <ul>
    <li class="row" id="row-alpha">Alpha <button id="remove-alpha">Remove</button></li>
    <li class="row" id="row-beta">Beta <button id="remove-beta">Remove</button></li>
  </ul>
  <div class="box" id="outer"><div class="box" id="inner">Deep</div></div>
  <span data-testid="count" id="count">7</span>
  <span style="visibility:hidden" data-testid="count">8</span>
  <table>
    <tr id="tr-acme"><td>Acme</td><td><a href="#a" id="edit-acme">Edit</a></td></tr>
    <tr id="tr-globex"><td>Globex</td><td><a href="#g" id="edit-globex">Edit</a></td></tr>
  </table>
  <button id="close-1" aria-label="Close">x</button><button id="close-2" aria-label="Close">x</button>
</main></body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(FIXTURE);
});

afterAll(async () => {
  await browser.close();
});

function exported(target: Target, on: Page = page): Promise<Locator> {
  return exportedLocator(target, on);
}

async function idOf(loc: Locator): Promise<string> {
  return loc.evaluate((el) => el.id, undefined, { timeout: 2_000 });
}

const CASES: [string, Target, string][] = [
  ["role and name, skipping a hidden match", { role: "button", name: "Save" }, "save-main"],
  ["role and name, exact", { role: "button", name: "Save", exact: true }, "save-main"],
  ["role and name within another target", { role: "button", name: "Save", within: { role: "dialog", name: "New" } }, "save-dialog"],
  ["role with nth", { role: "button", name: "Close", nth: 1 }, "close-2"],
  ["role with text as a has-text filter", { role: "row", text: "Globex" }, "tr-globex"],
  ["role with hasText", { role: "row", hasText: "Acme" }, "tr-acme"],
  ["link within a row", { role: "link", name: "Edit", within: { role: "row", text: "Globex" } }, "edit-globex"],
  ["label, exact", { label: "Club", exact: true }, "club"],
  ["label, exact match first", { label: "Club" }, "club"],
  ["label with a trailing *", { label: "Email" }, "email"],
  ["label with a nested hint", { label: "Address" }, "address"],
  ["label with an inline (Required ...) hint", { label: "Phone" }, "phone"],
  ["label within a dialog", { label: "Title", within: { role: "dialog", name: "New" } }, "dialog-title"],
  ["placeholder, whole text only", { placeholder: "Search" }, "search"],
  ["text, contained", { text: "Total: 3" }, "total-3"],
  ["text, exact", { text: "Total: 30", exact: true }, "total-30"],
  ["text as a /pattern/", { text: "/Total: \\d{2}/" }, "total-30"],
  ["css with hasText", { css: ".row", hasText: "Beta" }, "row-beta"],
  ["css, innermost", { css: ".box", hasText: "Deep", innermost: true }, "inner"],
  ["a test id, as css, skipping a hidden one", { css: "[data-testid=count]" }, "count"],
  ["text with nth", { text: "Remove", nth: 1 }, "remove-beta"],
  ["text within css", { text: "Remove", within: { css: ".row", hasText: "Alpha" } }, "remove-alpha"],
];

describe("exported locators mean what locate.ts means", () => {
  for (const [name, target, id] of CASES) {
    it(name, async () => {
      const ours = await idOf(await locate(target, page));
      expect(ours).toBe(id);
      expect(await idOf(await exported(target))).toBe(ours);
    });
  }

  it("a label never matches a label with extra words", async () => {
    // "Club" must not find "Club name" through the hint fallback.
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(`<label>Club name <input id="club-name"></label><label>Club <input id="club" disabled hidden></label>`);
      const ours = await locate({ label: "Club" }, fresh);
      const theirs = await exported({ label: "Club" }, fresh);
      expect(await ours.count()).toBe(0);
      expect(await theirs.count()).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});

// Capture uses the hint fallback only when the page has no exact label, and counts first/nth/last
// over the one set it picked; an `.or()` of both would count over both, in page order.
const LABEL_PAGES: [string, string, Target, string][] = [
  [
    "an exact label wins over an earlier hinted one",
    `<label>Email * <input id="billing"></label><label>Email <input id="contact"></label>`,
    { label: "Email" },
    "contact",
  ],
  [
    "nth counts over the exact labels only",
    `<label>Qty * <input id="qty-1"></label><label>Qty <input id="qty-2"></label><label>Qty <input id="qty-3"></label>`,
    { label: "Qty", nth: 1 },
    "qty-3",
  ],
  [
    "last counts over the exact labels only",
    `<label>Qty <input id="qty-1"></label><label>Qty <input id="qty-2"></label><label>Qty * <input id="qty-3"></label>`,
    { label: "Qty", innermost: true },
    "qty-2",
  ],
  [
    "a nested element's text is left out of the label, whatever it says",
    `<label>Name <span>(e.g. Jane Doe)</span><input id="name"></label>`,
    { label: "Name" },
    "name",
  ],
  [
    "a label's for= field, with the hint inline",
    `<label for="phone">Phone (Required for this action)</label><input id="phone">`,
    { label: "phone" },
    "phone",
  ],
  [
    "a field that points back at its label",
    `<label id="lbl-notes">Notes <b>optional</b></label><textarea id="notes" aria-labelledby="lbl-notes"></textarea>`,
    { label: "Notes" },
    "notes",
  ],
  [
    "the fallback within another target",
    `<form aria-label="Billing"><label>City * <input id="bill-city"></label></form><form aria-label="Shipping"><label>City * <input id="ship-city"></label></form>`,
    { label: "City", within: { role: "form", name: "Shipping" } },
    "ship-city",
  ],
];

describe("an exported label target decides like capture", () => {
  for (const [name, html, target, id] of LABEL_PAGES) {
    it(name, async () => {
      const fresh = await browser.newPage();
      try {
        await fresh.setContent(html);
        const ours = await idOf(await locate(target, fresh));
        expect(ours).toBe(id);
        expect(await idOf(await exported(target, fresh))).toBe(ours);
      } finally {
        await fresh.close();
      }
    });
  }

  it("fails on an ambiguous hinted label, as capture does", async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(`<label>Note * <input id="a"></label><label>Note: <input id="b"></label>`);
      const ours = await locate({ label: "Note" }, fresh).then(() => "found", (err: Error) => err.message);
      expect(ours).toContain("is ambiguous");
      const theirs = await exported({ label: "Note" }, fresh).then(() => "found", (err: Error) => err.message);
      expect(theirs).toBe(ours);
    } finally {
      await fresh.close();
    }
  });

  it("waits for a hinted label that isn't on the page yet", async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(`<div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = '<label>Email * <input id="late"></label>'; }, 300);</script>`);
      expect(await idOf(await exported({ label: "Email" }, fresh))).toBe("late");
    } finally {
      await fresh.close();
    }
  });
});
