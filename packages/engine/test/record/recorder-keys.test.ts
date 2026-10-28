// M38 review: what the recorder keeps of key presses, and a target check that times out once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Recorder, resolveTarget, type ElementInfo, type ResolvedTarget } from "../../src/record/index.js";
import { startFixtureServer, type FixtureServer } from "../capture/fixture-server.js";

const TEST_TIMEOUT = 60_000;
let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
}, TEST_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function recordOn(path: string, opts: Parameters<typeof Recorder.attach>[2] = {}): Promise<{ context: BrowserContext; page: Page; rec: Recorder }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.url}${path}`);
  const rec = await Recorder.attach(context, page, opts);
  return { context, page, rec };
}

const tick = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("recorded keys", () => {
  it(
    "keeps Enter in a field and shortcuts outside one; drops typing chords, Option/AltGr characters, Tab, Shift+Enter and password keys",
    async () => {
      const { context, page, rec } = await recordOn("/secret-fields.html");
      const password = page.locator("input[type=password]").first();
      await password.focus();
      await page.keyboard.press("Alt+s"); // Option+s on a Mac types ß
      await page.keyboard.press("Control+Alt+q"); // AltGr+q types @ on many layouts
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      const text = page.locator("input:not([type=password])").first();
      await text.focus();
      await page.keyboard.press("Control+k"); // in a field: typing, not a step
      await page.keyboard.press("Shift+Enter");
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Control+k");
      await page.keyboard.press("Escape");
      await tick(400);
      await rec.settled();
      const presses = (await rec.actions()).filter((a) => a.kind === "press");
      expect(presses.map((p) => (p.kind === "press" ? p.key : ""))).toEqual(["Control+k", "Escape"]);
      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "tries a target check again when the first try couldn't confirm it (a slow, busy page)",
    async () => {
      let calls = 0;
      const flaky: typeof resolveTarget = async (page, el: ElementInfo, kind) => {
        calls++;
        if (calls === 1) return { target: { label: "First name" }, verified: false, words: "First name" } satisfies ResolvedTarget;
        return resolveTarget(page, el, kind);
      };
      const { context, page, rec } = await recordOn("/record-form.html", { resolveTarget: flaky });
      await page.getByLabel("First name").fill("Jordan");
      await tick();
      await rec.settled();
      const [typed] = await rec.actions();
      expect(typed).toMatchObject({ kind: "type", at: { target: { label: "First name" }, verified: true } });
      expect(calls).toBe(2);
      await context.close();
    },
    TEST_TIMEOUT,
  );
});
