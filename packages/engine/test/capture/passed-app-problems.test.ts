// M39: a capture whose every step passes while the app answers a 5xx or throws an uncaught page
// error gets a failure report (category "app", decision 30), so CI lists it as a possible app bug
// with no repair command. Third-party 5xx and script errors are listed but fail nothing. Real
// Chromium against the capture fixture server; the third party is widgets.example.net (routed to
// the same server), the app "127.0.0.1".
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Action, Step, Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { appProblemFailure } from "../../src/capture/failure-report.js";
import { failureSummaryFor } from "../../src/ci/run.js";
import { tierForStatus } from "../../src/ci/tiers.js";
import { buildCommentMarkdown } from "../../src/ci/comment.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
let server: FixtureServer;
const tmpDirs: string[] = [];

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Totals</title></head><body><main>
<h1>Totals</h1><p id="state">Nothing loaded</p>
<button id="load">Load totals</button><button id="local-api">Load from local API</button><button id="crash">Refresh chart</button><button id="widget">Load widget</button>
</main><script>
const other = "http://widgets.example.net";
const state = document.getElementById("state");
document.getElementById("load").onclick = async () => {
  await fetch("/api/totals?token=abc").catch(() => {});
  state.textContent = "Totals shown";
};
document.getElementById("local-api").onclick = async () => {
  await fetch(new URLSearchParams(location.search).get("api") + "/api/totals").catch(() => {});
  state.textContent = "Local API answered";
};
document.getElementById("crash").onclick = () => {
  state.textContent = "Chart refreshed";
  throw new Error("chart data undefined");
};
document.getElementById("widget").onclick = () => {
  const s = document.createElement("script");
  s.src = other + "/segment.js";
  s.onerror = () => (state.textContent = "Widget loaded");
  document.head.appendChild(s);
};
</script></body></html>`;

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "/").split("?")[0];
  switch (path) {
    case "/totals.html":
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return true;
    case "/api/totals":
      res.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" }).end("{}");
      return true;
    case "/segment.js":
      res.writeHead(503, { "access-control-allow-origin": "*" }).end("unavailable");
      return true;
    default:
      return false;
  }
}

beforeEach(async () => {
  server = await startFixtureServer(handle);
}, TIMEOUT);

afterEach(async () => {
  await server.close();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function config(): ResolvedConfig {
  return {
    app: { baseUrl: server.url },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  };
}

const click = (name: string): Action => ({ do: "click", target: { role: "button", name } });
const waitForText = (text: string): Action => ({ do: "waitFor", target: { text } });

async function run(steps: Step[], page = "/totals.html") {
  const outDir = mkdtempSync(join(tmpdir(), "aida-passed-app-problems-"));
  tmpDirs.push(outDir);
  const walkthrough: Walkthrough = { walkthrough: "totals", title: "See the totals", start: { page }, steps };
  const result = await runCapture({
    walkthrough,
    config: config(),
    outDir,
    maxWaitMs: 3_000,
    onContext: async (context) => {
      await context.route("http://widgets.example.net/**", async (route) => {
        const u = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: `${server.url}${u.pathname}` }) });
      });
    },
  });
  return { ...result, outDir };
}

describe("a capture that passed every step while the app failed", () => {
  it(
    "a 5xx from the app's own API: an app failure report on disk, the capture not passed",
    async () => {
      const result = await run([
        { id: "open", actions: [waitForText("Nothing loaded")] },
        { id: "load", actions: [click("Load totals"), waitForText("Totals shown")] },
      ]);
      expect(result.validation.steps.every((s) => s.ok)).toBe(true);
      expect(result.validation.ok).toBe(false);
      const failure = result.failure!;
      expect(failure).toMatchObject({ step: "load", action: "run", category: "app", snapshot: "", screenshotPath: null });
      expect(failure.reason).toBe("suspected app bug: every step passed, but the server failed (GET /api/totals 500)");
      expect(failure.error).toBe("every step passed, but the app had 1 server error (5xx) during the capture");
      expect(failure.reason).not.toContain("token");
      expect(JSON.parse(readFileSync(join(result.outDir, "failure.json"), "utf8")).category).toBe("app");
    },
    TIMEOUT,
  );

  it(
    "a 5xx from the app's API on another port of this machine is the app's (M39 review)",
    async () => {
      // The app's API on another port: another origin, the same machine.
      const api = await startFixtureServer(handle);
      let result;
      try {
        result = await run([{ id: "local", actions: [click("Load from local API"), waitForText("Local API answered")] }], `/totals.html?api=${encodeURIComponent(api.url)}`);
      } finally {
        await api.close();
      }
      expect(result.validation.problems.server).toEqual([expect.objectContaining({ status: 500, step: "local" })]);
      expect(result.validation.problems.server[0].thirdParty).toBeUndefined();
      expect(result.validation.ok).toBe(false);
      expect(result.failure?.category).toBe("app");
      expect(result.failure?.reason).toMatch(/server failed \(GET 127\.0\.0\.1:\d+\/api\/totals 500\)/);
    },
    TIMEOUT,
  );

  it(
    "an uncaught error from the app's own script",
    async () => {
      const result = await run([{ id: "refresh", actions: [click("Refresh chart"), waitForText("Chart refreshed")]}]);
      expect(result.validation.ok).toBe(false);
      expect(result.failure?.category).toBe("app");
      expect(result.failure?.step).toBe("refresh");
      expect(result.failure?.reason).toMatch(/^suspected app bug: every step passed, but the page threw an uncaught error: .*chart data undefined/);
    },
    TIMEOUT,
  );

  it(
    "a third party's 5xx is listed but fails nothing, and writes no failure report",
    async () => {
      const result = await run([{ id: "widget", actions: [click("Load widget"), waitForText("Widget loaded")] }]);
      expect(result.validation.problems.server).toEqual([expect.objectContaining({ status: 503, thirdParty: true, step: "widget" })]);
      expect(result.validation.ok).toBe(true);
      expect(result.failure).toBeUndefined();
      // ...but never silently.
      expect(result.validation.warnings).toEqual([expect.stringMatching(/^ignored 1 third-party problem .*1 server error \(5xx\) from widgets\.example\.net/)]);
      expect(result.warnings).toEqual(result.validation.warnings);
      expect(existsSync(join(result.outDir, "failure.json"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("appProblemFailure", () => {
  it("names up to three server errors, an API on another origin by host, and page errors", () => {
    const f = appProblemFailure(
      {
        server: [
          { url: "http://127.0.0.1:3000/api/a", status: 500, method: "POST", step: "save" },
          { url: "https://api.example.com/v1/b", status: 502, method: "GET" },
          { url: "http://127.0.0.1:3000/api/c", status: 503, method: "GET" },
          { url: "http://127.0.0.1:3000/api/d", status: 500, method: "GET" },
          { url: "https://cdn.example.com/x.js", status: 503, thirdParty: true },
        ],
        page: [{ url: "http://127.0.0.1:3000/r", text: "TypeError: x is undefined\n    at f" }],
      },
      "http://127.0.0.1:3000/r?id=7",
    )!;
    expect(f.step).toBe("save");
    expect(f.url).toBe("http://127.0.0.1:3000/r");
    expect(f.reason).toBe(
      "suspected app bug: every step passed, but the server failed (POST /api/a 500, GET api.example.com/v1/b 502, GET /api/c 503 and 1 more), and the page threw an uncaught error: TypeError: x is undefined",
    );
    expect(f.error).toBe("every step passed, but the app had 4 server errors (5xx) and 1 page error during the capture");
    expect(appProblemFailure({ server: [{ url: "https://cdn.example.com/x.js", status: 503, thirdParty: true }], page: [] }, "http://127.0.0.1:3000/")).toBeUndefined();
  });

  it("CI lists it as a possible app bug, with no repair command", () => {
    const report = appProblemFailure({ server: [{ url: "http://127.0.0.1:3000/api/totals", status: 500, method: "GET", step: "load" }], page: [] }, "http://127.0.0.1:3000/totals")!;
    const failure = failureSummaryFor("totals", "aida.config.ts", report.error, report.step, report);
    expect(failure.repairCommand).toBeUndefined();
    expect(failure.category).toBe("app");
    const tier = tierForStatus("failed", failure.category);
    expect(tier).toBe("app");
    const md = buildCommentMarkdown(
      { base: "a".repeat(12), head: "b".repeat(12), affected: ["totals"], all: false, results: [{ walkthrough: "totals", status: "failed", tier, changedSteps: [], failure }], newRoutes: [], stalePages: [], outDir: "/tmp" },
      { urlFor: (p) => p },
    );
    expect(md).toContain("`totals` — possible app bug");
    expect(md).toContain("every step passed, but the server failed (GET /api/totals 500)");
    expect(md).not.toContain("aida-repair");
  });
});
