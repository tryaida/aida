import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMasks, clearMasks } from "../../src/capture/mask.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("applyMasks", () => {
  it("masks every matching element, not just the first (bug: mask.ts only masked loc.first())", async () => {
    await page.setContent(`
      <label>Email <input id="e1" value="ada@example.com" /></label>
      <label>Email <input id="e2" value="grace@example.com" /></label>
      <label>Email <input id="e3" value="linus@example.com" /></label>
    `);

    await applyMasks(page, ["Email"]);

    const filters = await page.evaluate(() =>
      ["e1", "e2", "e3"].map((id) => (document.getElementById(id) as HTMLElement).style.filter),
    );
    expect(filters).toEqual(["blur(8px)", "blur(8px)", "blur(8px)"]);

    await clearMasks(page);
    const cleared = await page.evaluate(() =>
      ["e1", "e2", "e3"].map((id) => (document.getElementById(id) as HTMLElement).style.filter),
    );
    expect(cleared).toEqual(["", "", ""]);
  });

  it("leaves unrelated fields unmasked", async () => {
    await page.setContent(`
      <label>Email <input id="e1" value="ada@example.com" /></label>
      <label>First name <input id="n1" value="Ada" /></label>
    `);

    await applyMasks(page, ["Email"]);

    const emailFilter = await page.evaluate(() => (document.getElementById("e1") as HTMLElement).style.filter);
    const nameFilter = await page.evaluate(() => (document.getElementById("n1") as HTMLElement).style.filter);
    expect(emailFilter).toBe("blur(8px)");
    expect(nameFilter).toBe("");

    await clearMasks(page);
  });
});
