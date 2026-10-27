// M36 review: a server action's read flag must land before the manifest is written (its headers
// are read asynchronously), and the end checks must not read the database while the last save is
// still in flight.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImpactTracker } from "../../src/capture/impact.js";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

let server: FixtureServer;
const dirs: string[] = [];
const g = globalThis as Record<string, unknown>;

beforeEach(async () => {
  g.__acmeSaved = false;
  server = await startFixtureServer((req, res) => {
    if (req.headers["next-action"] === "slow-read") {
      req.resume();
      // Answers late, with no revalidation: a read.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/x-component" });
        res.end("0:{}");
      }, 1_200);
      return true;
    }
    if (req.url === "/api/slow-save") {
      req.resume();
      // Longer than settle's network-idle cap: only waiting for the write itself sees it stored.
      setTimeout(() => {
        g.__acmeSaved = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 7_000);
      return true;
    }
    return false;
  });
});

afterEach(async () => {
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ImpactTracker.settled", () => {
  it("waits for a late server action's headers, so its read flag is set before the step's impact is used", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${server.url}/acme-slow-action.html`);
      const tracker = new ImpactTracker(page, server.url);
      const sent = page.waitForRequest((r) => r.headers()["next-action"] === "slow-read");
      await page.click("#go");
      await sent;
      // The step is over before the action answers: its impact is taken at once.
      const impact = tracker.take();
      expect(impact.requests.find((r) => r.action === "slow-read")?.read).toBeUndefined();
      const started = Date.now();
      await tracker.settled(5_000);
      expect(Date.now() - started).toBeLessThan(4_000);
      tracker.dispose();
      const action = impact.requests.find((r) => r.action === "slow-read");
      expect(action?.read).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("end checks wait for the last save", () => {
  it("runs validate.database only once the save request has answered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-end-check-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", database: "./database.mjs" };`,
    );
    writeFileSync(
      join(dir, "database.mjs"),
      `export default { url() { return "http://127.0.0.1:1"; }, async query() { return [{ saved: globalThis.__acmeSaved === true }]; }, async close() {} };`,
    );
    mkdirSync(join(dir, "walkthroughs"));
    writeFileSync(
      join(dir, "walkthroughs", "save-settings.yaml"),
      `walkthrough: save-settings
title: Save the settings
start: { page: /acme-slow-save.html }
steps:
  - id: save
    title: Save
    do: click "Save" button
    check: text "Saving…" is visible
validate:
  database:
    - name: settings-saved
      sql: select saved from settings
      expect: { saved: true }
`,
    );
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    let code: number;
    try {
      code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true, noReset: true });
    } finally {
      console.log = orig;
    }
    const validation = JSON.parse(readFileSync(join(dir, ".build", "save-settings", "capture", "validation.json"), "utf8"));
    expect(validation.dbChecks).toEqual([expect.objectContaining({ name: "settings-saved", ok: true })]);
    expect(code).toBe(0);
  }, 90_000);
});
