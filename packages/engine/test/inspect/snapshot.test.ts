import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { scanPage } from "../../src/inspect/snapshot.js";
import { clickToOpen, selectOption, InspectClickRefusedError } from "../../src/inspect/click.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

let server: FixtureServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

afterEach(async () => {
  await page?.close();
});

async function openFixture(): Promise<Page> {
  page = await browser.newPage();
  await page.goto(`${server.url}/index.html`);
  return page;
}

describe("scanPage", () => {
  it("distinguishes button vs link roles", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).toMatch(/button "Create Competitor"/);
    expect(snapshot).toMatch(/link "Back to list"/);
  });

  it("marks a disabled button", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).toMatch(/button "Cancel" \[disabled\]/);
  });

  it("marks required fields (input and native select)", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).toMatch(/textbox "First Name" \[required\]/);
    expect(snapshot).toMatch(/combobox "Class" \[required\]:/);
    expect(snapshot).not.toMatch(/textbox "Last Name \(optional\)" \[required\]/);
  });

  it("lists exact native <select> option labels, capped at 15 with a '+more' line", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).toContain('option "CK01 - Apple pie"');
    expect(snapshot).toContain('option "CK14 - Nut loaf"');
    expect(snapshot).not.toContain('option "CK15 - Orange cake"');
    expect(snapshot).toMatch(/\+4 more/);
  });

  it("redacts personal data but keeps example.com/fictional-range text", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).not.toContain("leaked@realcompany.com");
    expect(snapshot).toContain("test@example.com");
    expect(snapshot).toContain("0491 570 156");
  });

  it("scopes to --area as a CSS selector", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p, { area: "nav" });
    expect(snapshot).toContain("Somewhere else");
    expect(snapshot).not.toContain("Create Competitor");
  });

  it("scopes to --area as a landmark role name", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p, { area: "navigation" });
    expect(snapshot).toContain("Somewhere else");
    expect(snapshot).not.toContain("Create Competitor");
  });

  it("scopes to --area main on a page whose unscoped snapshot already shows the main landmark " +
    "(bug: '--area main' reported \"matched nothing\")", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p, { area: "main" });
    expect(snapshot).toContain("Create Competitor");
    expect(snapshot).not.toContain("Somewhere else");
  });

  it("falls back to the [role=\"main\"] attribute when there's no <main> tag", async () => {
    const p = await openFixture();
    await p.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return;
      const div = document.createElement("div");
      div.setAttribute("role", "main");
      div.innerHTML = main.innerHTML;
      main.replaceWith(div);
    });
    const { snapshot } = await scanPage(p, { area: "main" });
    expect(snapshot).toContain("Create Competitor");
  });

  it("throws clearly when --area matches nothing", async () => {
    const p = await openFixture();
    await expect(scanPage(p, { area: "#does-not-exist" })).rejects.toThrow(/matched nothing/);
  });

  it("does not include the hidden dialog until it's opened", async () => {
    const p = await openFixture();
    const { snapshot } = await scanPage(p);
    expect(snapshot).not.toContain("Record Payment");
  });

  it("includes an open dialog's contents after --click opens it", async () => {
    const p = await openFixture();
    await clickToOpen(p, "Open menu");
    const { snapshot } = await scanPage(p);
    expect(snapshot).toContain("Add Entry");
    expect(snapshot).toContain("Record Payment");
  });

  it("disambiguates two buttons sharing a role+name: within for a named group, nth with no group", async () => {
    page = await browser.newPage();
    await page.goto(`${server.url}/duplicates.html`);
    const { snapshot } = await scanPage(page);

    // Two "Delete" buttons, each inside a named group — both get a `within` disambiguator
    // naming their own group, not each other's.
    const deleteLines = snapshot.split("\n").filter((l) => l.includes('button "Delete"'));
    expect(deleteLines).toHaveLength(2);
    expect(deleteLines[0]).toContain('(within: "Riverbend entry")');
    expect(deleteLines[1]).toContain('(within: "Nullarbor entry")');

    // Two "Open" buttons with no named containing landmark — fall back to nth.
    const openLines = snapshot.split("\n").filter((l) => l.includes('button "Open"'));
    expect(openLines).toHaveLength(2);
    expect(openLines[0]).toContain("(nth: 0)");
    expect(openLines[1]).toContain("(nth: 1)");

    // "Create Competitor" appears once — never gets a disambiguator.
    expect(snapshot).not.toMatch(/Create Competitor"\s*\(/);
  });

  it("caps the whole snapshot at lineCap lines", async () => {
    const p = await openFixture();
    const { lineCount, truncated } = await scanPage(p, { lineCap: 10 });
    expect(lineCount).toBe(10);
    expect(truncated).toBe(true);
  });
});

describe("clickToOpen", () => {
  it("clicks an allowed button by name", async () => {
    const p = await openFixture();
    await clickToOpen(p, "Open menu");
    expect(await p.locator("#dialog").isVisible()).toBe(true);
  });

  it("refuses a name that looks like it submits/writes, without clicking", async () => {
    const p = await openFixture();
    await expect(clickToOpen(p, "Create Competitor")).rejects.toThrow(InspectClickRefusedError);
  });

  it("refuses a name that isn't a visible button/menuitem/tab", async () => {
    const p = await openFixture();
    await expect(clickToOpen(p, "Back to list")).rejects.toThrow(InspectClickRefusedError);
  });

  it("opens a custom (Radix-shaped) combobox, lists its listbox options, then closes it with Escape", async () => {
    page = await browser.newPage();
    await page.goto(`${server.url}/combobox.html`);
    const outcome = await clickToOpen(page, "Select competitor…");
    expect(outcome.listboxOptions).toEqual(["Acme Co", "Riverbend Show"]);
    expect(outcome.listboxTruncated).toBe(false);
    // Escape closed it again — inspect never leaves a listbox open behind it.
    await expect(page.locator("#listbox").isHidden()).resolves.toBe(true);
    await page.close();
  });
});

describe("selectOption", () => {
  it("selects a native <select> option by label", async () => {
    page = await browser.newPage();
    await page.goto(`${server.url}/combobox.html`);
    await selectOption(page, "Class", "Class A");
    await expect(page.locator("#native-class").inputValue()).resolves.toBe("a");
    await page.close();
  });

  it("drives a custom combobox/listbox, revealing a conditional field", async () => {
    page = await browser.newPage();
    await page.goto(`${server.url}/combobox.html`);
    await expect(page.locator("#conditional").isHidden()).resolves.toBe(true);
    await selectOption(page, "Select competitor…", "Riverbend Show");
    await expect(page.locator("#conditional").isHidden()).resolves.toBe(false);
    await page.close();
  });

  it("refuses a field name that doesn't resolve to a select/combobox", async () => {
    page = await browser.newPage();
    await page.goto(`${server.url}/combobox.html`);
    await expect(selectOption(page, "Nonexistent Field", "Anything")).rejects.toThrow(InspectClickRefusedError);
    await page.close();
  });
});
