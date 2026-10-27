import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locate, locateAll } from "../../src/capture/locate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "fixture", "label-hints.html"), "utf8");

const TEST_TIMEOUT = 30_000;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
}, TEST_TIMEOUT);

afterAll(async () => {
  await browser.close();
}, TEST_TIMEOUT);

// Each test below gets its own page off the one shared browser (cheaper than a browser per
// test, and these are fast DOM-only lookups — no network, no navigation).

describe("label targets: default matching falls back past hint text", () => {
  it(
    "matches a plain label exactly, no fallback needed",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Plain Label" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("plain");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back past '(Required for this action)' hint text",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "First Name" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("first-name");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back past '(Optional)' hint text",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Nickname" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("nickname");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back past a trailing '*' required marker",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Phone" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("phone");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "resolves uniquely to the field whose label, once hint markers are stripped, exactly equals the target " +
      "— a shared word prefix (bug: 'Email' used to loosely match 'Email Confirmation' too) is not enough",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Email" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("email");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails with a short message listing candidates when two different fields normalize to the exact same label",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      await expect(locate({ label: "Duplicate" }, page)).rejects.toThrow(/ambiguous/i);
      try {
        await locate({ label: "Duplicate" }, page);
      } catch (err) {
        expect((err as Error).message).toContain("Duplicate (Required for this action)");
        expect((err as Error).message).toContain("Duplicate (Optional)");
      }
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "never loosely matches a label that merely starts with the target text (bug: 'Name' matched 'Name of club')",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locateAll({ label: "Name" }, page);
      await expect(loc.count()).resolves.toBe(0);
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "prefers the real input over a decorative role=img icon inside the same label (bug: [role] matched first " +
      "in DOM order and won)",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Icon Field" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("icon-field");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "exact: true keeps the strict historical behaviour — no match past hint text",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locateAll({ label: "First Name", exact: true }, page);
      await expect(loc.count()).resolves.toBe(0);
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "matches the short name past a hint nested in a <span> (real-app shape: " +
      "'<label>Address <span>Optional</span></label>' has accessible name 'Address Optional')",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Address" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("address");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "matches a multi-word short name past a nested-<span> hint (real-app shape: " +
      "'<label>What it was <span>Required for this action</span></label>')",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "What it was" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("what-it-was");
      await page.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back to the label's full text when its only text lives inside a nested element " +
      "(no direct text node to use as the short name)",
    async () => {
      page = await browser.newPage();
      await page.setContent(FIXTURE);
      const loc = await locate({ label: "Email Only" }, page);
      await expect(loc.getAttribute("id")).resolves.toBe("email-only");
      await page.close();
    },
    TEST_TIMEOUT,
  );
});
