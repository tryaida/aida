// Regression tests for capture/locate.ts's target resolution beyond label matching (see
// label-fallback.test.ts for that): `nth` (picking the Nth of several role+name matches) and
// `role` + `text` (a hasText-style filter, not a second way to name the element — round-3
// first-capture friction: validation accepted `{role, text}` but locate.ts silently ignored
// `text` once `role` was set).
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locate } from "../../src/capture/locate.js";

const FIXTURE = `
<!doctype html>
<html>
  <body>
    <div role="group" aria-label="Riverbend entry">
      <button>Delete</button>
    </div>
    <div role="group" aria-label="Nullarbor entry">
      <button>Delete</button>
    </div>
    <table>
      <tr><td>Alice</td><td><button role="button" aria-label="Open">Open</button></td></tr>
      <tr><td>Bob</td><td><button role="button" aria-label="Open">Open</button></td></tr>
    </table>
  </body>
</html>
`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

describe("target.nth", () => {
  it("picks the 0-based Nth of several role+name matches", async () => {
    page = await browser.newPage();
    await page.setContent(FIXTURE);
    const first = await locate({ role: "button", name: "Delete", nth: 0 }, page);
    const second = await locate({ role: "button", name: "Delete", nth: 1 }, page);
    await expect(first.evaluate((el) => el.closest("div")?.getAttribute("aria-label"))).resolves.toBe(
      "Riverbend entry",
    );
    await expect(second.evaluate((el) => el.closest("div")?.getAttribute("aria-label"))).resolves.toBe(
      "Nullarbor entry",
    );
    await page.close();
  });
});

describe("target.role + target.text", () => {
  it("filters a role match down to the element containing `text`, instead of silently ignoring it", async () => {
    page = await browser.newPage();
    await page.setContent(FIXTURE);
    // Two `row`s both contain an "Open" button — `text` (not `name`, which only names the role
    // match itself) narrows to the row whose own text contains "Alice". Before the fix, `text`
    // was dropped entirely once `role` was set, so this would resolve to whichever row came
    // first (Alice's), making the assertion pass for the wrong reason on this fixture — the
    // second row (Bob's) proves the filter actually ran.
    const loc = await locate({ role: "row", text: "Bob" }, page);
    await expect(loc.evaluate((el) => el.textContent ?? "")).resolves.toContain("Bob");
    await expect(loc.evaluate((el) => el.textContent ?? "")).resolves.not.toContain("Alice");
    await page.close();
  });
});
