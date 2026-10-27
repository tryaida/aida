// Covers the M19 flake fix (docs/build-plan.md follow-ups: "two sub-0.2% screenshot flaps on
// identical pilot-app code ... a toast captured mid-fade, and one list row"). `waitForAnimations`
// waits for every running CSS animation/transition to finish before a doc screenshot is taken.
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForAnimations } from "../../src/capture/settle.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("waitForAnimations", () => {
  it("waits for a running CSS transition (toast mid-fade) to reach its end state", async () => {
    await page.setContent(`
      <style>
        #toast { opacity: 0; transition: opacity 150ms linear; }
        #toast.show { opacity: 1; }
      </style>
      <div id="toast">Saved</div>
    `);
    await page.evaluate(() => document.getElementById("toast")!.classList.add("show"));

    await waitForAnimations(page);

    const opacity = await page.evaluate(() => getComputedStyle(document.getElementById("toast")!).opacity);
    expect(opacity).toBe("1");
  });

  it("waits for a running Web Animation (a list row sliding in) to finish", async () => {
    await page.setContent(`<div id="row" style="transform: translateY(20px)">Row</div>`);
    await page.evaluate(() => {
      document.getElementById("row")!.animate([{ transform: "translateY(20px)" }, { transform: "translateY(0)" }], {
        duration: 150,
        fill: "forwards",
      });
    });

    await waitForAnimations(page);

    const finished = await page.evaluate(() => document.getAnimations().every((a) => a.playState === "finished"));
    expect(finished).toBe(true);
  });

  it("never hangs on an animation that never settles (bounded timeout)", async () => {
    await page.setContent(`<div id="spinner">Loading</div>`);
    await page.evaluate(() => {
      document.getElementById("spinner")!.animate([{ opacity: 1 }, { opacity: 0.5 }], {
        duration: 500,
        iterations: Infinity,
      });
    });

    const start = Date.now();
    await waitForAnimations(page, 300);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("is a no-op when nothing is animating", async () => {
    await page.setContent(`<div>Plain content</div>`);
    await expect(waitForAnimations(page)).resolves.toBeUndefined();
  });
});
