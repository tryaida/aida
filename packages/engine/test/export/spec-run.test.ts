// Exported specs run in a real browser do what capture does on the same page: a `/pattern/` text
// check, a `select` on a custom dropdown or a native <select>, and a `goto` path relative to the
// page. Capture's side is the code it runs (text-check.ts, locate.ts, runner.ts's dropdown lookup).
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import * as YAML from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { locate } from "../../src/capture/locate.js";
import { waitForText } from "../../src/capture/text-check.js";
import { resolveComboboxListbox } from "../../src/capture/runner.js";
import { walkthroughToSpec } from "../../src/export/index.js";
import { docToWalkthrough, WalkthroughDocSchema, type Target } from "../../src/walkthrough/index.js";
import { runSpec } from "./run-spec.js";

const BASE = "http://example.com/";

let browser: Browser;
let context: BrowserContext;
let pages: Record<string, string>;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await context?.close();
});

/** A page whose requests to example.com are answered from `pages` by path, never the network. */
async function site(served: Record<string, string>): Promise<Page> {
  pages = served;
  context = await browser.newContext();
  await context.route("http://example.com/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = pages[path];
    return body === undefined ? route.fulfill({ status: 404, body: "not found" }) : route.fulfill({ contentType: "text/html", body });
  });
  return context.newPage();
}

function spec(yaml: string): string {
  const wt = docToWalkthrough(WalkthroughDocSchema.parse(YAML.parse(yaml)));
  return walkthroughToSpec(wt, { source: "walkthroughs/x.yaml", signIn: false, stateSetups: new Set(), providers: {}, device: "desktop", databaseReset: false });
}

/** Capture's text check on the same page: passes, or the error it fails with. */
async function captureText(page: Page, target: Target, text: string, exact: boolean): Promise<string> {
  return waitForText(await locate(target, page), text, exact, 500).then(
    () => "passed",
    () => "failed",
  );
}

async function specResult(text: string, page: Page): Promise<string> {
  return runSpec(text, page, BASE).then(
    () => "passed",
    (err: Error) => `failed: ${err.message.split("\n")[0]}`,
  );
}

const TEXT_PAGE = `<!doctype html><body>
<div id="state">
  Paid
</div>
<p id="total"><span>Total:</span>
  <span>3 items</span></p>
</body>`;

describe("an exported /pattern/ text check reads the text as capture does", () => {
  const CHECKS: [string, Target, string, boolean, string][] = [
    ["a whole-text pattern over text with line breaks around it", { css: "#state" }, "/Paid|Settled/", true, "passed"],
    ["a pattern across two elements on separate lines", { css: "#total" }, "/Total: \\d+ items/", false, "passed"],
    ["a pattern that ignores case", { css: "#total" }, "/total: 3 ITEMS/i", false, "passed"],
    ["a pattern the text doesn't have", { css: "#state" }, "/Refunded/", false, "failed"],
    ["a plain string, unchanged", { css: "#total" }, "Total: 3 items", true, "passed"],
  ];
  for (const [name, target, text, exact, want] of CHECKS) {
    it(name, async () => {
      const page = await site({ "/": TEXT_PAGE });
      await page.goto(BASE);
      expect(await captureText(page, target, text, exact)).toBe(want);
      const yaml = `walkthrough: x\ntitle: X\nstart: { page: / }\nsteps:\n  - title: Check\n    actions:\n      - do: expect\n        target: ${JSON.stringify(target)}\n        text: ${JSON.stringify(text)}\n        exact: ${exact}\n`;
      expect((await specResult(spec(yaml), page)).split(":")[0]).toBe(want);
    }, 20_000);
  }
});

// A custom dropdown whose options only appear once it's opened, with a decoy listbox earlier on
// the page that also has an "Open" option.
const DROPDOWN_PAGE = `<!doctype html><body>
<ul role="listbox" aria-label="Saved filters"><li role="option" id="decoy" onclick="window.decoyClicked = true">Open</li></ul>
<button id="status" aria-controls="status-list" aria-haspopup="listbox">Choose a status</button>
<ul role="listbox" id="status-list" hidden>
  <li role="option">Open</li><li role="option">Closed</li>
</ul>
<button id="stuck" aria-controls="stuck-list">Pick a size</button>
<ul role="listbox" id="stuck-list" hidden><li role="option">Large</li></ul>
<label>Plan <select id="plan"><option value="basic">Basic</option><option value="pro">Pro plan</option></select></label>
<script>
  for (const [button, list, updates] of [["status", "status-list", true], ["stuck", "stuck-list", false]]) {
    document.getElementById(button).onclick = () => { document.getElementById(list).hidden = false; };
    for (const option of document.getElementById(list).children) {
      option.onclick = () => {
        document.getElementById(list).hidden = true;
        if (updates) document.getElementById(button).textContent = option.textContent;
      };
    }
  }
</script>
</body>`;

const selectYaml = (target: Target, option: string) =>
  `walkthrough: x\ntitle: X\nstart: { page: / }\nsteps:\n  - title: Pick\n    actions:\n      - do: select\n        target: ${JSON.stringify(target)}\n        option: ${JSON.stringify(option)}\n`;

describe("an exported select does what capture does", () => {
  it("clicks the option in the listbox the dropdown controls, not the first on the page", async () => {
    const page = await site({ "/": DROPDOWN_PAGE });
    await page.goto(BASE);
    // Capture's lookup, once the dropdown is open.
    const trigger = await locate({ role: "button", name: "Choose a status" }, page);
    await trigger.click();
    expect(await (await resolveComboboxListbox(trigger, page)).getAttribute("id")).toBe("status-list");
    await page.reload();

    expect(await specResult(spec(selectYaml({ role: "button", name: "Choose a status" }, "Open")), page)).toBe("passed");
    expect(await page.locator("#status").textContent()).toBe("Open");
    expect(await page.evaluate(() => (window as unknown as { decoyClicked?: boolean }).decoyClicked ?? false)).toBe(false);
  }, 30_000);

  it("fails when the dropdown doesn't show the option after it was clicked, as capture does", async () => {
    const page = await site({ "/": DROPDOWN_PAGE });
    await page.goto(BASE);
    const result = await specResult(spec(selectYaml({ role: "button", name: "Pick a size" }, "Large")), page);
    expect(result).toContain('select: "Large" does not appear selected');
  }, 30_000);

  it("picks a native <select>'s option by its label, else its value", async () => {
    const page = await site({ "/": DROPDOWN_PAGE });
    await page.goto(BASE);
    expect(await specResult(spec(selectYaml({ label: "Plan" }, "Pro plan")), page)).toBe("passed");
    expect(await page.locator("#plan").inputValue()).toBe("pro");
    expect(await specResult(spec(selectYaml({ label: "Plan" }, "basic")), page)).toBe("passed");
    expect(await page.locator("#plan").inputValue()).toBe("basic");
  }, 30_000);
});

describe("an exported goto opens the page capture opens", () => {
  const PATHS: [string, string][] = [
    ["edit", "http://example.com/things/edit"],
    ["?tab=2", "http://example.com/things/1?tab=2"],
    ["/settings", "http://example.com/settings"],
  ];
  for (const [path, want] of PATHS) {
    it(`goto ${path}`, async () => {
      const html = "<!doctype html><p>ok</p>";
      const page = await site({ "/things/1": html, "/things/edit": html, "/settings": html });
      // Capture (runner.ts `goto`) resolves the path against the page it is on.
      expect(new URL(path, `${BASE}things/1`).href).toBe(want);
      const yaml = `walkthrough: x\ntitle: X\nstart: { page: /things/1 }\nsteps:\n  - title: Go\n    actions:\n      - do: goto\n        path: ${JSON.stringify(path)}\n`;
      expect(await specResult(spec(yaml), page)).toBe("passed");
      expect(page.url()).toBe(want);
    }, 20_000);
  }
});
