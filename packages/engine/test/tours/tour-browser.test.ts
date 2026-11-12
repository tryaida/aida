import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { buildTours, TOUR_VERSION } from "../../src/tours/index.js";

// M46 end to end: capture fixture walkthroughs, build their tours, then load the fixture app with
// tour.js (served from a second origin, as a help site would be) and play the reader.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixture");
const TOUR_JS = join(here, "../../../help-app/public/tour.js");
const TIMEOUT = 60_000;

interface Served {
  url: string;
  requests: string[];
  /** Each request's path and the Referer it carried. */
  log: { url: string; referer?: string }[];
  close(): Promise<void>;
}

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Served> {
  const requests: string[] = [];
  const log: Served["log"] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? "");
      log.push({ url: req.url ?? "", referer: req.headers.referer });
      handler(req, res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, requests, log, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const dirs: string[] = [];
let app: Served;
let help: Served;
// A second "help site" a tab's saved state might name: nothing may ever be fetched from it.
let evil: Served;
let publicDir: string;
let browser: Browser;

const addThing: Walkthrough = {
  walkthrough: "add-a-thing",
  title: "Add a thing",
  start: { page: "/list.html" },
  data: { thing: { name: "Acme widget" } },
  steps: [
    {
      id: "open",
      title: "Open the form",
      actions: [
        { do: "click", target: { role: "link", name: "New thing" } },
        { do: "waitFor", target: { role: "heading", name: "New thing" } },
      ],
    },
    { id: "name", title: "Name it", actions: [{ do: "type", target: { label: "Name" }, text: "{{thing.name}}" }] },
    { id: "colour", title: "Pick a colour", actions: [{ do: "select", target: { label: "Colour" }, option: "Blue" }] },
    {
      id: "create",
      title: "Create it",
      actions: [
        { do: "click", target: { role: "button", name: "Create" } },
        { do: "waitFor", target: { role: "heading", name: "Created" } },
      ],
    },
    { id: "check", title: "Check it", page_text: "The thing is **created**.", actions: [{ do: "expect", target: { role: "heading", name: "Created" } }] },
  ],
};

const seeDetails: Walkthrough = {
  walkthrough: "see-details",
  title: "See details",
  start: { page: "/list.html" },
  steps: [
    {
      id: "open",
      title: "Open details",
      actions: [
        { do: "click", target: { role: "button", name: "Open details" } },
        { do: "waitFor", target: { role: "button", name: "Save details" } },
      ],
    },
    { id: "save", title: "Save them", actions: [{ do: "click", target: { role: "button", name: "Save details" } }] },
  ],
};

function config(baseUrl: string): ResolvedConfig {
  return { app: { baseUrl }, configDir: tmpdir(), walkthroughsDir: tmpdir(), outDir: tmpdir(), buildDir: tmpdir(), viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 };
}

function writeTour(id: string, tour: unknown): void {
  writeFileSync(join(publicDir, "tours", `${id}.json`), JSON.stringify(tour));
}

const oneStep = (id: string, target: Record<string, unknown>, screen = "/list.html") => ({
  version: TOUR_VERSION,
  id,
  title: "Delete a thing",
  guideUrl: "/how-do-i/delete-a-thing",
  start: { path: screen, pattern: screen },
  steps: [{ id: "delete", title: "Delete it", text: "Select Delete.", screen, actions: [{ kind: "click", target, advance: "click" }] }],
});

const button = (name: string) => ({ tag: "button", role: "button", name });

type TourStepJson = { id: string; title: string; text: string; screen: string; actions: Record<string, unknown>[] };
const tourOf = (id: string, steps: TourStepJson[]) => ({
  version: TOUR_VERSION,
  id,
  title: `Tour ${id}`,
  guideUrl: `/how-do-i/${id}`,
  start: { path: steps[0]!.screen, pattern: steps[0]!.screen },
  steps,
});
const click = (target: Record<string, unknown>) => ({ kind: "click", target, advance: "click" });
const typeIn = (label: string) => ({ kind: "type", target: { tag: "input", role: "textbox", name: label, label }, advance: "change" });

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "aida-tour-browser-"));
  dirs.push(root);
  publicDir = join(root, "public");
  mkdirSync(join(publicDir, "tours"), { recursive: true });

  help = await serve((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const headers = { "access-control-allow-origin": "*" };
    try {
      if (path === "/tour.js") {
        res.writeHead(200, { ...headers, "content-type": "text/javascript" });
        res.end(readFileSync(TOUR_JS));
        return;
      }
      const m = /^\/tours\/([a-z0-9-]+)\.json$/.exec(path);
      if (m) {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(readFileSync(join(publicDir, "tours", `${m[1]}.json`)));
        return;
      }
    } catch {
      // fall through to 404
    }
    res.writeHead(404, headers);
    res.end("not found");
  });
  evil = await serve((_req, res) => {
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end("not found");
  });
  app = await serve((req, res) => {
    let path = (req.url ?? "/").split("?")[0]!;
    // `/app/...`: the same app served under a base path, its script tag saying so;
    // `/app2/...`: under a base path its script tag doesn't name (start() passes it).
    const base = /^\/app2?(?=\/)/.exec(path)?.[0] ?? "";
    path = path.slice(base.length);
    if (path === "/" || path === "/details") path = "/list.html";
    try {
      let html = readFileSync(join(FIXTURE, path), "utf8").replaceAll("__HELP__", help.url);
      if (base === "/app") html = html.replace(/data-help-url="([^"]*)"/, 'data-help-url="$1" data-base-path="/app"');
      // An app that hands its full address to every site it loads from: the tour must not.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "unsafe-url" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });

  const sources = [];
  for (const wf of [addThing, seeDetails]) {
    const captureDir = join(root, "capture", wf.walkthrough);
    const result = await runCapture({ walkthrough: wf, config: config(app.url), outDir: captureDir });
    expect(result.validation.ok).toBe(true);
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(result.manifest));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(result.validation));
    sources.push({ wf, captureDir });
  }
  const built = buildTours({ sources, publicDir });
  expect(built.written).toEqual(["add-a-thing", "see-details"]);

  writeTour("missing-thing", oneStep("missing-thing", { tag: "button", role: "button", name: "Nowhere" }));
  // A step that belongs to another screen, whose control's name also exists on the list.
  writeTour("on-settings", oneStep("on-settings", button("Open details"), "/settings.html"));
  writeTour("fill-form", tourOf("fill-form", [
    { id: "name", title: "Your name", text: "Type your name.", screen: "/form.html", actions: [typeIn("Name")] },
    { id: "email", title: "Your email", text: "Type your email.", screen: "/form.html", actions: [typeIn("Email")] },
  ]));
  writeTour("confirm-it", tourOf("confirm-it", [
    { id: "open", title: "Open the dialog", text: "", screen: "/dialog.html", actions: [click(button("Open dialog"))] },
    { id: "confirm", title: "Confirm it", text: "", screen: "/dialog.html", actions: [click(button("Confirm"))] },
    { id: "done", title: "That's it", text: "", screen: "/dialog.html", actions: [] },
  ]));
  writeTour("far", oneStep("far", button("Far away"), "/tall.html"));
  writeTour("busy-missing", oneStep("busy-missing", button("Nowhere"), "/busy.html"));
  writeTour("busy-found", oneStep("busy-found", button("Steady"), "/busy.html"));
  writeTour("huge", oneStep("huge", button("Huge"), "/big.html"));
  writeTour("row-a", oneStep("row-a", { ...button("Delete"), within: { tag: "tr", role: "row", name: "Widget A Delete" } }, "/rows.html"));
  writeTour("row-b", oneStep("row-b", { ...button("Delete"), within: { tag: "tr", role: "row", name: "Widget B Delete" } }, "/rows.html"));
  writeTour("open-thing", oneStep("open-thing", { tag: "a", role: "link", name: "Open", href: "/things/*" }, "/rows.html"));
  writeTour("open-any", oneStep("open-any", { tag: "a", role: "link", name: "Open" }, "/rows.html"));
  writeTour("archive", oneStep("archive", button("Archive"), "/rows.html"));
  writeTour("old-version", { ...oneStep("old-version", button("Open details")), version: 1 });
  writeTour("resume-me", tourOf("resume-me", [
    { id: "intro", title: "Before you start", text: "", screen: "/list.html", actions: [] },
    { id: "open", title: "Open the form", text: "", screen: "/list.html", actions: [click({ tag: "a", role: "link", name: "New thing" })] },
    { id: "name", title: "Name it", text: "", screen: "/new.html", actions: [typeIn("Name")] },
  ]));
  writeTour("two-deletes", oneStep("two-deletes", { tag: "button", role: "button", name: "Delete" }));
  const hostile = oneStep("hostile", { tag: "button", role: "button", name: "Open details" }) as Record<string, unknown> & { steps: Record<string, unknown>[] };
  hostile.title = '<img src=x onerror="window.__pwned=1">';
  hostile.guideUrl = "javascript:alert(1)";
  hostile.steps[0]!.title = "<b>Bold?</b>";
  hostile.steps[0]!.text = '<img src=x onerror="window.__pwned=1"> Select it.';
  (hostile.steps[0]!.actions as Record<string, unknown>[])[0]!.example = "<script>window.__pwned=1</script>";
  writeTour("hostile", hostile);

  browser = await chromium.launch();
}, TIMEOUT * 3);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await help?.close();
  await evil?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Every tour event, and whether anything on the page read a field's typed value, kept across page
// loads in sessionStorage; and how often anything asks for an animation frame or runs a selector
// query (the tour is the only thing on these pages that does).
const WATCH = `
window.__calls = { raf: 0, qsa: 0 };
(function () {
  var raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (f) { window.__calls.raf++; return raf.call(window, f); };
  var qsa = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (s) { window.__calls.qsa++; return qsa.call(this, s); };
})();
window.addEventListener("aida-tour", function (e) {
  var l = JSON.parse(sessionStorage.getItem("test-events") || "[]");
  l.push(e.detail.type + ":" + e.detail.id + ":" + e.detail.step);
  sessionStorage.setItem("test-events", JSON.stringify(l));
});
[HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement].forEach(function (C) {
  var d = Object.getOwnPropertyDescriptor(C.prototype, "value");
  Object.defineProperty(C.prototype, "value", {
    configurable: true,
    get: function () { sessionStorage.setItem("value-read", "1"); return d.get.call(this); },
    set: function (v) { d.set.call(this, v); },
  });
});
`;

async function withPage(fn: (page: Page, context: BrowserContext) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await context.addInitScript(WATCH);
  const page = await context.newPage();
  try {
    await fn(page, context);
  } finally {
    await context.close();
  }
}

const pop = (page: Page) => page.locator("[data-aida-tour] .pop");
const startButton = (page: Page) => pop(page).getByRole("button", { name: "Start" });
const startTour = (page: Page, opts: Record<string, unknown>) =>
  page.evaluate((o) => (window as unknown as { AidaTour: { start(o: object): Promise<boolean> } }).AidaTour.start(o), opts);
const active = (page: Page) => page.evaluate(() => (window as unknown as { AidaTour: { active(): unknown } }).AidaTour.active());
const calls = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __calls: { raf: number; qsa: number } }).__calls }));
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? null);

/** Two boxes overlap. */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
const ring = (page: Page) => page.locator("[data-aida-tour] .ring");
const events = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("test-events") || "[]") as string[]);

/** The ring sits 6px outside the element on every side. */
async function expectRingAround(page: Page, selector: Parameters<Page["getByRole"]>) {
  const target = page.getByRole(...selector);
  await expect.poll(async () => {
    const r = await ring(page).boundingBox();
    const t = await target.boundingBox();
    if (!r || !t) return "no box";
    return Math.abs(r.x - (t.x - 6)) <= 2 && Math.abs(r.y - (t.y - 6)) <= 2 && Math.abs(r.width - (t.width + 12)) <= 2 ? "ringed" : JSON.stringify({ r, t });
  }, { timeout: 5_000 }).toBe("ringed");
}

async function focusedInTour(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const host = document.activeElement;
    if (!host || !host.hasAttribute("data-aida-tour")) return null;
    return host.shadowRoot?.activeElement?.className ?? null;
  });
}

describe("tour.js in the live app", () => {
  it("runs a captured walkthrough: query start, ring, the reader's click, a full page load, change, read step, finish", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html?aida-tour=add-a-thing&keep=1`);
      // A link only offers the tour: nothing is pointed at, and focus stays put, until Start.
      await expect.poll(() => pop(page).textContent()).toContain("Add a thing");
      expect(new URL(page.url()).search).toBe("?keep=1");
      expect(await ring(page).isVisible()).toBe(false);
      expect(await focusedInTour(page)).toBeNull();
      expect(await active(page)).toBeNull();
      await startButton(page).click();
      await expect.poll(() => pop(page).textContent()).toContain("Step 1 of 5");
      await expectRingAround(page, ["link", { name: "New thing" }]);
      expect(await focusedInTour(page)).toContain("pop");

      // The reader clicks: the tour advances and resumes on the next page.
      await page.getByRole("link", { name: "New thing" }).click();
      await page.waitForURL(/new\.html/);
      await expect.poll(() => pop(page).textContent()).toContain("Step 2 of 5");
      await expectRingAround(page, ["textbox", { name: "Name" }]);
      // Resumed on a new page without a click in the tour: focus is the page's, not the tour's.
      expect(await focusedInTour(page)).toBeNull();
      expect(await pop(page).textContent()).toContain("For example: Acme widget");
      expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe(""); // never entered for the reader

      // Typing and leaving the field advances, on `change`, without the tour reading it.
      await page.getByRole("textbox", { name: "Name" }).click();
      await page.keyboard.type("My own thing");
      await page.keyboard.press("Tab");
      await expect.poll(() => pop(page).textContent()).toContain("Step 3 of 5");
      expect(await page.evaluate(() => sessionStorage.getItem("value-read"))).toBeNull();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("colour");
      await expectRingAround(page, ["combobox", { name: "Colour" }]);

      await page.getByRole("combobox", { name: "Colour" }).selectOption("Blue");
      await expect.poll(() => pop(page).textContent()).toContain("Step 4 of 5");
      await expectRingAround(page, ["button", { name: "Create" }]);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/done\.html/);
      await expect.poll(() => pop(page).textContent()).toContain("Step 5 of 5");
      expect(await pop(page).textContent()).toContain("The thing is created.");
      expect(await ring(page).isVisible()).toBe(false);

      await pop(page).getByRole("button", { name: "Finish" }).click();
      await expect.poll(() => pop(page).textContent()).toContain("You've reached the end of this guide.");
      await pop(page).getByRole("button", { name: "Close" }).click();
      await expect.poll(() => page.locator("[data-aida-tour]").count()).toBe(0);
      expect(await page.evaluate(() => sessionStorage.getItem("aida-tour"))).toBeNull();
      expect(await page.evaluate(() => sessionStorage.getItem("value-read"))).toBeNull();
      const seen = await events(page);
      expect(seen[0]).toBe("started:add-a-thing:0");
      expect(seen).toContain("step:add-a-thing:4");
      expect(seen.at(-1)).toBe("finished:add-a-thing:4");
    });
  }, TIMEOUT);

  it("follows client-side navigation to an element that renders later", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html`);
      expect(await page.evaluate(() => (window as unknown as { AidaTour: { start(o: object): Promise<boolean> } }).AidaTour.start({ id: "see-details" }))).toBe(true);
      await expectRingAround(page, ["button", { name: "Open details" }]);
      await page.getByRole("button", { name: "Open details" }).click();
      await page.waitForURL(/\/details$/);
      await expect.poll(() => pop(page).textContent()).toContain("Step 2 of 2");
      await expectRingAround(page, ["button", { name: "Save details" }]);
    });
  }, TIMEOUT);

  it("says it can't find a missing element and links to the guide", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html?aida-tour=missing-thing`);
      await startButton(page).click();
      await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
      const link = pop(page).getByRole("link", { name: "Open the full guide" });
      expect(await link.getAttribute("href")).toBe(`${help.url}/how-do-i/delete-a-thing`);
      expect(await pop(page).getByRole("button", { name: "Skip" }).isVisible()).toBe(true);
      expect(await ring(page).isVisible()).toBe(false);
    });
  }, TIMEOUT);

  it("never guesses between two matching elements", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html?aida-tour=two-deletes`);
      await startButton(page).click();
      await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
      expect(await ring(page).isVisible()).toBe(false);
    });
  }, TIMEOUT);

  it("rings a match only when the hints make it the only one, and lets go when a second appears", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/rows.html`);
      // Certain: the row's name, or the link's screen pattern, leaves one candidate.
      for (const [id, expected] of [["row-a", 0], ["open-thing", 0]] as const) {
        expect(await startTour(page, { id })).toBe(true);
        const target = id === "row-a" ? page.getByRole("button", { name: "Delete" }).nth(expected) : page.getByRole("link", { name: "Open" }).nth(expected);
        await expect.poll(async () => {
          const r = await ring(page).boundingBox();
          const t = await target.boundingBox();
          return r && t ? Math.abs(r.x - (t.x - 6)) <= 2 && Math.abs(r.y - (t.y - 6)) <= 2 : false;
        }).toBe(true);
      }
      // Uncertain: two rows of the same name, two links of the same name and no path to tell.
      for (const id of ["row-b", "open-any"]) {
        await startTour(page, { id });
        await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
        expect(await ring(page).isVisible()).toBe(false);
      }
      // Unique when found; then the app adds a second "Archive": the ring goes.
      await startTour(page, { id: "archive" });
      await expectRingAround(page, ["button", { name: "Archive" }]);
      await page.evaluate(() => (window as unknown as { addTwin(): void }).addTwin());
      await expect.poll(() => ring(page).isVisible()).toBe(false);
      await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
    });
  }, TIMEOUT);

  it("never rings a same-named control on another screen", async () => {
    await withPage(async (page) => {
      // The step is on /settings.html; the list has the one "Open details" there is.
      await page.goto(`${app.url}/list.html`);
      expect(await startTour(page, { id: "on-settings" })).toBe(true);
      await expect.poll(() => pop(page).textContent()).toContain("This step happens on another screen.");
      await page.waitForTimeout(1_000);
      expect(await ring(page).isVisible()).toBe(false);
    });
  }, TIMEOUT);

  it("says when the reader is on another screen, with a link to where it starts", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/done.html?aida-tour=add-a-thing`);
      await startButton(page).click();
      await expect.poll(() => pop(page).textContent()).toContain("This step happens on another screen.");
      expect(await pop(page).getByRole("link", { name: "Go to where this starts" }).getAttribute("href")).toBe("/list.html");
    });
  }, TIMEOUT);

  it("doesn't take focus from the field the reader is typing in when the step changes", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/form.html`);
      await startTour(page, { id: "fill-form" });
      await expectRingAround(page, ["textbox", { name: "Name" }]);
      await page.getByRole("textbox", { name: "Name" }).click();
      await page.keyboard.type("Jo");
      // Tab fires `change`, which moves the tour on; the next keystrokes belong to Email.
      await page.keyboard.press("Tab");
      await page.keyboard.type("jo@example.com");
      await expect.poll(() => pop(page).textContent()).toContain("Step 2 of 2");
      expect(await activeId(page)).toBe("email");
      expect(await page.getByRole("textbox", { name: "Email" }).inputValue()).toBe("jo@example.com");
    });
  }, TIMEOUT);

  it("leaves a new page's autofocused field alone when it resumes there", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/form.html`);
      await page.evaluate(() => sessionStorage.setItem("aida-tour", JSON.stringify({ id: "fill-form", step: "name", action: 0 })));
      await page.reload();
      await expect.poll(() => pop(page).textContent()).toContain("Step 1 of 2");
      await expectRingAround(page, ["textbox", { name: "Name" }]);
      expect(await activeId(page)).toBe("name");
    });
  }, TIMEOUT);

  it("resumes on the saved step by its id, and drops a saved step the tour no longer has", async () => {
    await withPage(async (page) => {
      // The tour gained a step before "name" since this position was saved as the 2nd step.
      await page.goto(`${app.url}/new.html`);
      await page.evaluate(() => sessionStorage.setItem("aida-tour", JSON.stringify({ id: "resume-me", step: "name", action: 0 })));
      await page.reload();
      await expect.poll(() => pop(page).textContent()).toContain("Name it");
      expect(await pop(page).textContent()).toContain("Step 3 of 3");

      await page.evaluate(() => sessionStorage.setItem("aida-tour", JSON.stringify({ id: "resume-me", step: "gone", action: 0 })));
      await page.reload();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("aida-tour"))).toBeNull();
      expect(await page.locator("[data-aida-tour]").count()).toBe(0);
      // An old numeric position isn't a step id either.
      await page.evaluate(() => sessionStorage.setItem("aida-tour", JSON.stringify({ id: "resume-me", step: 2, action: 0 })));
      await page.reload();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("aida-tour"))).toBeNull();
      expect(await page.locator("[data-aida-tour]").count()).toBe(0);
    });
  }, TIMEOUT);

  it("never trusts a help site address saved in the tab", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/nohelp.html`);
      await page.evaluate((h) => sessionStorage.setItem("aida-tour", JSON.stringify({ id: "add-a-thing", step: "open", action: 0, helpUrl: h })), evil.url);
      await page.reload();
      await page.waitForTimeout(800);
      expect(evil.requests).toEqual([]);
      expect(await page.locator("[data-aida-tour]").count()).toBe(0);
    });
  }, TIMEOUT);

  it("works inside the app's modal dialog, and leaves Escape to the dialog there", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/dialog.html`);
      await startTour(page, { id: "confirm-it" });
      await expectRingAround(page, ["button", { name: "Open dialog" }]);
      await page.getByRole("button", { name: "Open dialog" }).click();
      await expect.poll(() => pop(page).textContent()).toContain("Step 2 of 3");
      await expectRingAround(page, ["button", { name: "Confirm" }]);
      // In the dialog (the top layer), so painted above it and not inert: the box takes clicks.
      expect(await page.locator("dialog [data-aida-tour]").count()).toBe(1);
      const box = (await pop(page).boundingBox())!;
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.hasAttribute("data-aida-tour") ?? false, [box.x + box.width / 2, box.y + 8])).toBe(true);
      await pop(page).getByRole("button", { name: "Next" }).click({ timeout: 3_000 });
      await expect.poll(() => pop(page).textContent()).toContain("Step 3 of 3");
      expect(await focusedInTour(page)).toContain("pop");
      // Escape in the box: the browser closes the app's dialog as from any control in it; the
      // tour stays, and moves back out.
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => (document.getElementById("dlg") as HTMLDialogElement).open)).toBe(false);
      await expect.poll(() => page.locator("dialog [data-aida-tour]").count()).toBe(0);
      expect(await page.locator("[data-aida-tour]").count()).toBe(1);
      expect(await active(page)).not.toBeNull();
    });
  }, TIMEOUT);

  it("sends no referrer with its requests, even from an app that would send its full address", async () => {
    await withPage(async (page) => {
      const before = help.log.length;
      await page.goto(`${app.url}/list.html?token=secret-value`);
      await startTour(page, { id: "see-details" });
      await expectRingAround(page, ["button", { name: "Open details" }]);
      const mine = help.log.slice(before).filter((r) => r.url.startsWith("/tours/") || r.url.startsWith("/brand/"));
      expect(mine.map((r) => r.url)).toContain("/tours/see-details.json");
      for (const r of mine) expect(r.referer, r.url).toBeUndefined();
      // The app's own requests to the help site still carry it (the header is in force).
      expect(help.log.slice(before).find((r) => r.url === "/tour.js")?.referer).toContain("token=secret-value");
    });
  }, TIMEOUT);

  it("scrolls to an element once per action, not again when the app re-renders it", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/tall.html`);
      await startTour(page, { id: "far" });
      await expectRingAround(page, ["button", { name: "Far away" }]);
      // The scroll is smooth: let it finish before measuring it and before the reader scrolls
      // away, or the reset below lands mid-animation and measures the animation, not tour.js.
      let last = -1;
      await expect
        .poll(async () => {
          const y = await page.evaluate(() => window.scrollY);
          const settled = y === last;
          last = y;
          return settled;
        }, { intervals: [150] })
        .toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1_000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => (window as unknown as { rerender(): void }).rerender());
      await page.waitForTimeout(1_000);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  }, TIMEOUT);

  it("stays light on a busy page: no frame loop, and backs off once it has said it can't find", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/busy.html`);
      await startTour(page, { id: "busy-found" });
      await expectRingAround(page, ["button", { name: "Steady" }]);
      let a = await calls(page);
      await page.waitForTimeout(2_000);
      let b = await calls(page);
      // A frame loop asks for ~120 frames in 2s.
      expect(b.raf - a.raf).toBeLessThan(40);

      await startTour(page, { id: "busy-missing" });
      await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
      a = await calls(page);
      await page.waitForTimeout(2_000);
      b = await calls(page);
      // Every 80ms for good would be ~25 searches in 2s; backed off, text and class changes
      // aren't watched any more.
      expect(b.qsa - a.qsa).toBeLessThan(10);
      expect(b.raf - a.raf).toBeLessThan(10);
    });
  }, TIMEOUT);

  it("never puts its box over the ringed element: it folds, and the reader can fold or unfold it", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/big.html`);
      await startTour(page, { id: "huge" });
      await expectRingAround(page, ["button", { name: "Huge" }]);
      await expect.poll(async () => overlaps((await pop(page).boundingBox())!, (await ring(page).boundingBox())!)).toBe(false);
      const show = pop(page).getByRole("button", { name: "Show" });
      expect(await show.getAttribute("aria-expanded")).toBe("false");
      await show.click();
      await expect.poll(() => pop(page).getByRole("heading", { name: "Delete it" }).isVisible()).toBe(true);
      await pop(page).getByRole("button", { name: "Hide" }).click();
      await expect.poll(() => pop(page).getByRole("heading", { name: "Delete it" }).isVisible()).toBe(false);

      // Nothing to ring: the box keeps to the bottom left, clear of where apps put Save.
      await page.goto(`${app.url}/list.html`);
      await startTour(page, { id: "missing-thing" });
      await expect.poll(() => pop(page).textContent(), { timeout: 10_000 }).toContain("Can't find this on the screen");
      const box = (await pop(page).boundingBox())!;
      expect(box.x).toBeLessThan(100);
    });
  }, TIMEOUT);

  it("reads its screens relative to the app's base path", async () => {
    await withPage(async (page) => {
      writeTour("based", oneStep("based", button("Open details")));
      await page.goto(`${app.url}/app/list.html`);
      await startTour(page, { id: "based" });
      await expectRingAround(page, ["button", { name: "Open details" }]);
      // Elsewhere under the base path: the start link keeps it.
      await page.goto(`${app.url}/app/done.html`);
      await startTour(page, { id: "based" });
      await expect.poll(() => pop(page).textContent()).toContain("This step happens on another screen.");
      expect(await pop(page).getByRole("link", { name: "Go to where this starts" }).getAttribute("href")).toBe("/app/list.html");
      // A base path the script tag doesn't name, passed to start().
      await page.goto(`${app.url}/app2/list.html`);
      await startTour(page, { id: "based", basePath: "/app2" });
      await expectRingAround(page, ["button", { name: "Open details" }]);
    });
  }, TIMEOUT);

  it("refuses a tour file of a version it doesn't know and offers the full guide", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html`);
      expect(await startTour(page, { id: "old-version" })).toBe(false);
      await expect.poll(() => pop(page).textContent()).toContain("This guide can't be shown inside the app here.");
      expect(await pop(page).getByRole("link", { name: "Open the full guide" }).getAttribute("href")).toBe(`${help.url}/how-do-i/delete-a-thing`);
      expect(await ring(page).isVisible()).toBe(false);
      expect(await active(page)).toBeNull();
    });
  }, TIMEOUT);

  it("ends on Escape and gives focus back", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html`);
      await page.getByRole("button", { name: "Open details" }).focus();
      await page.evaluate(() => (window as unknown as { AidaTour: { start(o: object): Promise<boolean> } }).AidaTour.start({ id: "add-a-thing" }));
      await expect.poll(() => focusedInTour(page)).toContain("pop");
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator("[data-aida-tour]").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-details");
      expect(await page.evaluate(() => sessionStorage.getItem("aida-tour"))).toBeNull();
      expect((await events(page)).at(-1)).toBe("stopped:add-a-thing:0");
      expect(await page.evaluate(() => (window as unknown as { AidaTour: { active(): unknown } }).AidaTour.active())).toBeNull();
    });
  }, TIMEOUT);

  it("refuses a bad id without fetching anything", async () => {
    await withPage(async (page) => {
      const before = help.requests.filter((r) => r.startsWith("/tours/")).length;
      await page.goto(`${app.url}/list.html?aida-tour=..%2Fsecret`);
      await page.waitForFunction(() => !location.search.includes("aida-tour"));
      expect(await page.evaluate(() => (window as unknown as { AidaTour: { start(o: object): Promise<boolean> } }).AidaTour.start({ id: "Bad/ID" }))).toBe(false);
      expect(await page.locator("[data-aida-tour]").count()).toBe(0);
      expect(help.requests.filter((r) => r.startsWith("/tours/")).length).toBe(before);
    });
  }, TIMEOUT);

  it("shows hostile strings as text and drops a link that isn't a site path", async () => {
    await withPage(async (page) => {
      await page.goto(`${app.url}/list.html?aida-tour=hostile`);
      await startButton(page).click();
      await expect.poll(() => pop(page).textContent()).toContain("<b>Bold?</b>");
      const text = await pop(page).textContent();
      expect(text).toContain('<img src=x onerror="window.__pwned=1"> Select it.');
      expect(text).toContain("<script>window.__pwned=1</script>");
      expect(await page.locator("[data-aida-tour] img, [data-aida-tour] script, [data-aida-tour] b:not(.example b)").count()).toBe(0);
      expect(await page.locator("[data-aida-tour] .pop a").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    });
  }, TIMEOUT);
});
