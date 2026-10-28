import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { convertPlaywrightFile, loadPlaywrightConverters, playwrightImportInstallHint } from "../../src/walkthrough/convert-playwright.js";
import { WalkthroughDocSchema, docToWalkthrough } from "../../src/walkthrough/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../fixtures/playwright/products.e2e.ts");
const text = readFileSync(fixture, "utf8");

describe("convertPlaywrightFile", () => {
  it("produces one draft per test(), folding in beforeEach and the describe title", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    expect(drafts).toHaveLength(2);

    const [products, standalone] = drafts;
    expect(products.id).toBe("ui-product-list-search-and-filters-examples-10-to-12");
    expect(standalone.id).toBe("ui-standalone-test-with-no-describe");
  });

  it("every draft parses and validates against our own schema, TODOs and all", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    for (const draft of drafts) {
      const raw = YAML.parse(draft.yaml);
      const parsed = WalkthroughDocSchema.parse(raw);
      const wt = docToWalkthrough(parsed);
      expect(wt.steps.length).toBeGreaterThan(0);
    }
  });

  it("maps goto, click, fill, select, check and expect toBeVisible/toHaveText/toHaveURL", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    const products = drafts[0];
    const raw = YAML.parse(products.yaml);
    const actions = raw.steps.flatMap((s: { actions?: unknown[] }) => s.actions ?? []);

    expect(actions).toEqual(
      expect.arrayContaining([
        { do: "goto", path: "/catalog/products" },
        { do: "waitForUrl", pattern: "q=10" },
      ]),
    );
    expect(actions.some((a: { do: string }) => a.do === "click")).toBe(true);
    expect(actions.some((a: { do: string }) => a.do === "type")).toBe(true);
    expect(actions.some((a: { do: string }) => a.do === "select" && a.option === "Example Supplier A")).toBe(true);
  });

  it("folds the within-scoped filter/within chain into a nested target", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    const raw = YAML.parse(drafts[0].yaml);
    const actions: Array<{ do: string; target?: { within?: { role?: string; name?: string } } }> =
      raw.steps.flatMap((s: { actions?: unknown[] }) => s.actions ?? []);
    const outdoorClick = actions.find(
      (a) => a.do === "click" && a.target?.within?.role === "group",
    );
    expect(outdoorClick?.target?.within).toEqual({ role: "group", name: "Category" });
  });

  it("masks an email-shaped fill value and keeps a non-personal one as-is", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    const raw = YAML.parse(drafts[0].yaml);
    const values = Object.values(raw.data as Record<string, string>);
    expect(values).toContain("person@example.com");
    expect(values).not.toContain("jordan@realcompany.com");
    expect(values).toContain("10");
  });

  it("counts the sign-in helper separately and notes it rather than treating it as a plain TODO", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    expect(drafts[0].signInNotes).toBe(1);
    expect(drafts[0].yaml).toMatch(/sign-in: handled by the configured sign-in adapter/);
  });

  it("leaves unmapped calls (toBeChecked) as TODO comments and counts them", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    const products = drafts[0];
    expect(products.unmapped).toBeGreaterThanOrEqual(1);
    expect(products.yaml).toMatch(/TODO from test:.*toBeChecked/);
    expect(products.yaml).not.toMatch(/TODO from test:.*press\('Enter'\)/);
  });

  it("maps locator.press to a press in that field, and toHaveText to an exact text check", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    const actions = YAML.parse(drafts[0].yaml).steps.flatMap((s: { actions?: unknown[] }) => s.actions ?? []);
    expect(actions).toContainEqual({ do: "press", key: "Enter", target: { label: "/^SKU/" } });
    expect(actions).toContainEqual({ do: "expect", target: { role: "heading" }, text: "Product list", exact: true });
  });
});

describe("convertPlaywrightFile: keyboard, hover, focus and text checks (M38)", () => {
  const ordersFixture = join(here, "../fixtures/playwright/orders.e2e.ts");
  const ordersText = readFileSync(ordersFixture, "utf8");

  async function ordersActions() {
    const { drafts } = await convertPlaywrightFile(ordersText, ordersFixture);
    const raw = YAML.parse(drafts[0].yaml);
    WalkthroughDocSchema.parse(raw);
    return { draft: drafts[0], raw, actions: raw.steps.flatMap((s: { actions?: unknown[] }) => s.actions ?? []) };
  }

  it("maps page.keyboard.press, locator.press, hover and focus", async () => {
    const { actions } = await ordersActions();
    expect(actions).toContainEqual({ do: "focus", target: { placeholder: "Search orders" } });
    expect(actions).toContainEqual({ do: "press", key: "Enter", target: { placeholder: "Search orders" } });
    expect(actions).toContainEqual({ do: "hover", target: { role: "button", name: "Actions" } });
    expect(actions).toContainEqual({ do: "press", key: "Control+K" });
    expect(actions).toContainEqual({ do: "press", key: "Escape" });
  });

  it("maps toHaveText to an exact check, toContainText and a regex toHaveText to a contains check", async () => {
    const { actions } = await ordersActions();
    expect(actions).toContainEqual({ do: "expect", target: { role: "status" }, text: "1 order found", exact: true });
    expect(actions).toContainEqual({ do: "expect", target: { role: "row", name: "/ORD-1001/" }, text: "Acme Garden Supplies" });
    expect(actions).toContainEqual({ do: "expect", target: { role: "heading" }, text: "/Order ORD-1001/" });
    expect(actions).toContainEqual({ do: "expect", target: { text: "Saved", exact: true } });
  });

  it("leaves only the call it has no form for (toBeDisabled) as a TODO", async () => {
    const { draft } = await ordersActions();
    expect(draft.unmapped).toBe(1);
    expect(draft.mapped).toBe(14);
    expect(draft.yaml).toMatch(/TODO from test:.*toBeDisabled/);
  });

  it("leaves calls whose options change what they do as TODOs, and keeps text literal (M38 review)", async () => {
    const spec = `
import { expect, test } from '@playwright/test';
test('options', async ({ page }) => {
  await page.click('#row-menu', { button: 'right' });
  await page.getByRole('button', { name: 'Save' }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Save' }).click({ timeout: 5000 });
  await page.click('text=Open');
  await expect(page.getByRole('status')).toHaveText('/orders/');
  await expect(page.getByRole('status')).toHaveText('Saved', { ignoreCase: true });
  await expect(page.getByRole('status')).toContainText(/saved/i);
  await expect(page.getByRole('status')).toHaveText(/saved/g);
  await expect(page.getByRole('status')).toHaveText('Saved', { useInnerText: true });
  await expect(page.getByRole('dialog')).toBeVisible({ visible: false });
  await page.keyboard.press('Entr');
  await page.getByLabel('Search').press('ctrl+k');
});`;
    const { drafts } = await convertPlaywrightFile(spec, "options.spec.ts");
    const raw = YAML.parse(drafts[0].yaml);
    WalkthroughDocSchema.parse(raw);
    const actions = raw.steps.flatMap((s: { actions?: unknown[] }) => s.actions ?? []);
    expect(actions).toEqual([
      { do: "click", target: { role: "button", name: "Save" } },
      { do: "click", target: { css: "text=Open" } },
      { do: "expect", target: { role: "status" }, text: "/\\/orders\\//", exact: true },
      { do: "expect", target: { role: "status" }, text: "/Saved/i", exact: true },
      { do: "expect", target: { role: "status" }, text: "/saved/i" },
      { do: "press", key: "Control+k", target: { label: "Search" } },
    ]);
    expect(drafts[0].unmapped).toBe(6);
    for (const call of ["button: 'right'", "modifiers", "/saved/g", "useInnerText", "visible: false", "Entr"]) {
      expect(drafts[0].yaml).toContain(call);
    }
  });

  it("writes placeholder narration for the new actions", async () => {
    const { raw } = await ordersActions();
    const says = raw.steps.map((s: { say: string }) => s.say);
    expect(says).toContain('Hover over "Actions".');
    expect(says).toContain("Press Ctrl+K.");
    expect(says).toContain('In "Search orders", press Enter.');
    expect(says).toContain('Check that the status shows exactly "1 order found".');
  });

  it("carries a draft banner naming the source file and test title", async () => {
    const { drafts } = await convertPlaywrightFile(text, fixture);
    expect(drafts[0].yaml).toMatch(/^# DRAFT — generated by `aida import playwright`/m);
    expect(drafts[0].yaml).toContain('test "ui: product list search and filters (examples 10 to 12)"');
  });
});

describe("playwrightImportInstallHint", () => {
  it("recognizes a missing-typescript module error, however Node phrases it", () => {
    expect(playwrightImportInstallHint(new Error("Cannot find package 'typescript' imported from /x/extract.js"))).toBe(
      "install typescript to import Playwright tests: npm i -D typescript",
    );
    expect(playwrightImportInstallHint(new Error("Cannot find module 'typescript'"))).toBe(
      "install typescript to import Playwright tests: npm i -D typescript",
    );
  });

  it("leaves an unrelated error alone", () => {
    expect(playwrightImportInstallHint(new Error("Cannot find package 'yaml'"))).toBeUndefined();
    expect(playwrightImportInstallHint(new Error("boom"))).toBeUndefined();
  });
});

describe("loadPlaywrightConverters", () => {
  it("turns a missing-typescript failure in the loader into the actionable error, without touching node_modules", async () => {
    const err = new Error("Cannot find package 'typescript' imported from /fake/extract.js");
    await expect(loadPlaywrightConverters(() => Promise.reject(err))).rejects.toThrow(
      "install typescript to import Playwright tests: npm i -D typescript",
    );
  });

  it("rethrows an unrelated loader failure as-is", async () => {
    await expect(loadPlaywrightConverters(() => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
  });

  it("resolves the real modules by default", async () => {
    const { extractTests, convertStatements } = await loadPlaywrightConverters();
    expect(typeof extractTests).toBe("function");
    expect(typeof convertStatements).toBe("function");
  });
});
