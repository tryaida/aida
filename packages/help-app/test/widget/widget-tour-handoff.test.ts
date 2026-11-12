// What widget.js hands tour.js (M46, decisions 41-42), in real Chromium: an app served under a
// base path, on one origin, that would send its full address (query tokens and all) to every site
// it loads from; the help site on another. The widget passes its base path on, and neither its own
// requests nor the tour.js it loads carry a referrer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "widget.js");
const TIMEOUT = 30_000;

const HELP_MAP = {
  version: 1,
  guides: [{ id: "close-poll", title: "Close a poll", url: "/how-do-i/close-poll", steps: 1, starts: "/polls/*", screens: [], tour: true }],
};

let browser: Browser;
let helpServer: Server;
let appServer: Server;
let helpOrigin = "";
let appOrigin = "";
const requests: { path: string; referer?: string }[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    }),
  );
}

function handleHelp(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0]!;
  requests.push({ path, referer: req.headers.referer });
  const cors = { "access-control-allow-origin": "*" };
  const json = (body: unknown): void => {
    res.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify(body));
  };
  switch (path) {
    case "/widget.js":
      res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(WIDGET, "utf8"));
      return;
    case "/tour.js":
      // A stub of tour.js's contract that records what the widget gave it.
      res.writeHead(200, { "content-type": "text/javascript" }).end(`
        var s = document.currentScript;
        window.__tourScript = { helpUrl: s.getAttribute("data-help-url"), basePath: s.getAttribute("data-base-path"), referrerPolicy: s.referrerPolicy };
        window.__tourStarts = [];
        window.AidaTour = { start: function (opts) { window.__tourStarts.push(opts); }, active: function () { return null; } };`);
      return;
    case "/help-map.json":
      return json(HELP_MAP);
    case "/search-index.json":
      return json([]);
    case "/brand/theme.json":
      return json({ primary: "#123456" });
    case "/api/chat":
      return json({ available: false });
    default:
      res.writeHead(404, cors).end();
  }
}

beforeAll(async () => {
  browser = await chromium.launch();
  helpServer = createServer(handleHelp);
  helpOrigin = await listen(helpServer);
  appServer = createServer((_req, res) => {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "unsafe-url" })
      .end(`<!doctype html><html lang="en"><head><title>Acme polls</title></head><body><h1>Acme polls</h1>
        <script src="${helpOrigin}/widget.js" data-help-url="${helpOrigin}" data-base-path="/app"></script></body></html>`);
  });
  appOrigin = (await listen(appServer)).replace("127.0.0.1", "localhost");
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => helpServer.close(() => r(undefined)));
  await new Promise((r) => appServer.close(() => r(undefined)));
});

describe("widget.js hands tour.js its base path and no referrer", () => {
  it(
    "loads tour.js with data-base-path and no referrer, starts it with the base path, and sends no referrer itself",
    async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${appOrigin}/app/polls/42?token=secret-value`);
        await page.getByRole("button", { name: "Help", exact: true }).click();
        await page.getByRole("button", { name: "Show me how: Close a poll" }).click();
        await expect.poll(() => page.evaluate(() => (window as { __tourStarts?: unknown[] }).__tourStarts)).toEqual([{ id: "close-poll", helpUrl: helpOrigin, basePath: "/app" }]);
        expect(await page.evaluate(() => (window as { __tourScript?: unknown }).__tourScript)).toEqual({ helpUrl: helpOrigin, basePath: "/app", referrerPolicy: "no-referrer" });

        // The page's own <script src=".../widget.js"> is the app's markup and carries what the
        // app's policy says; everything the widget asks for itself carries nothing.
        expect(requests.find((r) => r.path === "/widget.js")?.referer).toContain("token=secret-value");
        const own = requests.filter((r) => r.path !== "/widget.js");
        expect(own.map((r) => r.path)).toEqual(expect.arrayContaining(["/brand/theme.json", "/help-map.json", "/tour.js"]));
        for (const r of own) expect(r.referer, r.path).toBeUndefined();
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});
