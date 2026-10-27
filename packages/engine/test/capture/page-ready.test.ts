// Decision 37: real pages keep a long-lived request open (a live-updates stream), so a wait for
// network idle never ends. `gotoReady` waits for load, idle at most a short cap, then a settle.
import { createServer, type Server, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gotoReady, waitForPageReady } from "../../src/capture/page-ready.js";

let browser: Browser;
let server: Server;
let base = "";
const open: ServerResponse[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    if (req.url === "/stream") {
      // Never answered in full: a live-updates connection.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      open.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>Acme dashboard</h1><script>fetch("/stream").then(r => r.body.getReader().read())</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  for (const res of open) res.destroy();
  await browser.close();
  await new Promise((r) => server.close(() => r(undefined)));
});

describe("gotoReady", () => {
  it("returns soon after load on a page that never goes network-idle", async () => {
    const page = await browser.newPage();
    const started = Date.now();
    await gotoReady(page, `${base}/`, 20_000, { idleCapMs: 1_000, settleMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await page.locator("h1").textContent()).toBe("Acme dashboard");
    // The same on an already-open page.
    const again = Date.now();
    await waitForPageReady(page, 20_000, { idleCapMs: 1_000, settleMs: 50 });
    expect(Date.now() - again).toBeLessThan(3_000);
    await page.close();
  });

  it("still fails when the page doesn't load at all", async () => {
    const page = await browser.newPage();
    await expect(gotoReady(page, "http://127.0.0.1:9/", 5_000)).rejects.toThrow();
    await page.close();
  });
});
