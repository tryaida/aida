// M28 review fixes (decision 30): third-party traffic never counts as the app's, a stale screen is
// told apart by a diagnosis-only reload, a save split across steps or still waiting is named, a
// 403 or a redirect at the start points at the persona or a missing precondition, a loading
// skeleton isn't a blank page, and what capture writes for an agent is redacted. Real Chromium
// against the capture fixture server; the third party is widgets.example.net (routed to the same
// server), the app "127.0.0.1".
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Action, Step, Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { appOrigins, classifyFailure, isAppOrigin, isSignInPath, isThirdPartyError, siteOf } from "../../src/capture/diagnose.js";
import { runLevelFailure } from "../../src/capture/failure-report.js";
import type { FailureChanges } from "../../src/capture/types.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
const MAX_WAIT_MS = 1_500;
const TOKEN = "Zx9kQ2mT7vB4nR8pL3wY";

let server: FixtureServer;
let list: string[];
const tmpDirs: string[] = [];

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`);
}

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "/").split("?")[0];
  const cors = { "access-control-allow-origin": "*" };
  switch (path) {
    case "/collect":
    case "/g/collect":
      res.writeHead(204, cors).end();
      return true;
    case "/segment.js":
    case "/v1/projects":
      res.writeHead(503, cors).end("unavailable");
      return true;
    case "/widget.js":
      res.writeHead(200, { "content-type": "text/javascript", ...cors });
      res.end('setTimeout(function widgetTick() { throw new Error("widget broke"); }, 0);');
      return true;
    case "/api/registrations":
      res.writeHead(200, { "content-type": "application/json", ...cors }).end("{}");
      return true;
    case "/api/slow":
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(200).end("{}");
      }, 8_000);
      return true;
    case "/api/list":
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          list.push(body);
          res.writeHead(200).end("{}");
        });
        return true;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
      return true;
    case "/dashboard":
      res.writeHead(302, { location: "/select-show?message=Please%20select%20a%20show" }).end();
      return true;
    case "/select-show":
      html(res, 200, "<h1>Select a show</h1>");
      return true;
    case "/reports":
      res.writeHead(302, { location: "/login?next=%2Freports" }).end();
      return true;
    case "/login":
      html(res, 200, "<h1>Sign in</h1>");
      return true;
    case "/settings/auth":
      html(res, 200, "<h1>Auth settings</h1>");
      return true;
    case "/forbidden":
      html(res, 403, "<h1>Not allowed</h1>");
      return true;
    case `/invite/${TOKEN}`:
      html(res, 200, "<h1>Accept your invite</h1>");
      return true;
    default:
      return false;
  }
}

beforeEach(async () => {
  list = [];
  server = await startFixtureServer(handle);
}, TIMEOUT);

afterEach(async () => {
  await server.close();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function config(extra: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    app: { baseUrl: server.url },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    ...extra,
  };
}

/** The third party's origin, answered by the fixture server's own handler. */
const THIRD_PARTY = "http://widgets.example.net";

async function routeThirdParty(context: BrowserContext): Promise<void> {
  await context.route(`${THIRD_PARTY}/**`, async (route) => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `${server.url}${u.pathname}${u.search}` });
    await route.fulfill({ response });
  });
}

const click = (name: string): Action => ({ do: "click", target: { role: "button", name } });
const waitForText = (text: string): Action => ({ do: "waitFor", target: { text } });

async function run(steps: Step[], opts: { page?: string; config?: ResolvedConfig } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "aida-diagnose-more-"));
  tmpDirs.push(outDir);
  const walkthrough: Walkthrough = {
    walkthrough: "register",
    title: "Register",
    start: { page: opts.page ?? "/diagnose-more.html", persona: { role: "admin" }, signed_in_as: "admin" },
    steps,
  };
  const result = await runCapture({ walkthrough, config: opts.config ?? config(), outDir, maxWaitMs: MAX_WAIT_MS, onContext: routeThirdParty });
  return { ...result, outDir };
}

async function fail(actions: Action[], opts: { page?: string; config?: ResolvedConfig } = {}) {
  const result = await run([{ id: "save", actions }], opts);
  expect(result.failure).toBeDefined();
  return result.failure!;
}

describe("third-party traffic is not the app's", () => {
  it(
    "analytics beacons and a third-party POST don't make a no-op click look like a save",
    async () => {
      const failure = await fail([click("Track only"), waitForText("Registration saved")]);
      expect(failure.changes!.writes).toEqual([]);
      expect(failure.category).toBe("walkthrough");
      expect(failure.reason).toMatch(/never found \(nothing saved/);
    },
    TIMEOUT,
  );

  it(
    "a 503 from a CDN script or a third-party API is not an app bug",
    async () => {
      const result = await run([{ id: "save", actions: [click("Load widget"), waitForText("Registration saved")] }]);
      const failure = result.failure!;
      // The 503s really happened (the run's own problem list sees every 5xx)...
      expect(result.validation.problems.server.map((p) => new URL(p.url).pathname).sort()).toEqual(["/segment.js", "/v1/projects"]);
      // ...but they aren't the app's.
      expect(failure.changes!.errorResponses).toEqual([]);
      expect(failure.changes!.consoleErrors.count).toBe(0);
      expect(failure.category).toBe("walkthrough");
    },
    TIMEOUT,
  );

  it(
    "an error thrown by a cross-origin script is ignored",
    async () => {
      const result = await run([{ id: "save", actions: [click("Widget crash"), waitForText("Registration saved")] }]);
      const failure = result.failure!;
      expect(result.validation.problems.page.map((p) => p.text)).toEqual([expect.stringMatching(/widget broke|Script error/)]);
      expect(failure.changes!.pageErrors.count).toBe(0);
      expect(failure.category).toBe("walkthrough");
    },
    TIMEOUT,
  );

  it(
    "an API on another origin counts once it's in capture.apiOrigins",
    async () => {
      const without = await fail([click("Save to API"), waitForText("Registration saved")]);
      expect(without.changes!.writes).toEqual([]);

      const apiOrigin = THIRD_PARTY;
      const withApi = await fail([click("Save to API"), waitForText("Registration saved")], {
        config: config({ capture: { apiOrigins: [apiOrigin] } }),
      });
      const host = new URL(apiOrigin).host;
      expect(withApi.changes!.writes).toEqual([{ method: "POST", path: `${host}/api/registrations`, status: 200 }]);
      expect(withApi.category).toBe("app");
    },
    TIMEOUT,
  );

  it("appOrigins: baseUrl, configured API origins, and a *SUPABASE_URL from the environment", () => {
    const origins = appOrigins("http://127.0.0.1:3000/app", ["https://api.example.com/v1", "not a url"], {
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      OTHER_URL: "https://ignored.example.com",
    });
    expect([...origins].sort()).toEqual(["http://127.0.0.1:3000", "https://abc.supabase.co", "https://api.example.com"]);
  });

  it("isAppOrigin: every port on this machine for a local app, and the app's own site (M39 review)", () => {
    const local = new Set(["http://localhost:3000"]);
    for (const u of ["http://localhost:8000/api", "http://127.0.0.1:3000/x", "http://[::1]:5173/src/main.ts", "http://api.localhost:4000/"]) {
      expect(isAppOrigin(u, local)).toBe(true);
    }
    expect(isAppOrigin("https://cdn.example.com/x.js", local)).toBe(false);
    const site = new Set(["https://app.acme.test"]);
    expect(isAppOrigin("https://api.acme.test/v1", site)).toBe(true);
    expect(isAppOrigin("https://acme.test/", site)).toBe(true);
    expect(isAppOrigin("https://acme-cdn.test/", site)).toBe(false);
    expect(isAppOrigin("http://localhost:3000/", site)).toBe(false);
    // Under a shared suffix the site is one label more: another tenant is a third party.
    expect(isAppOrigin("https://api.acme.co.uk/", new Set(["https://app.acme.co.uk"]))).toBe(true);
    expect(isAppOrigin("https://other.co.uk/", new Set(["https://app.acme.co.uk"]))).toBe(false);
    expect(isAppOrigin("https://someone-else.vercel.app/", new Set(["https://acme.vercel.app"]))).toBe(false);
    // An IP address is only ever its own origin (unless both are this machine).
    expect(isAppOrigin("http://10.0.0.6:3000/", new Set(["http://10.0.0.5:3000"]))).toBe(false);
    expect(siteOf("app.acme.com.au")).toBe("acme.com.au");
    expect(siteOf("10.0.0.5")).toBeUndefined();
  });

  it("isThirdPartyError: errors whose frames are all a third party's; never a local dev server's or an opaque one", () => {
    const local = new Set(["http://localhost:3000"]);
    // A Vite dev server on another port is the app's.
    expect(isThirdPartyError({ message: "x", stack: "Error: x\n    at f (http://localhost:5173/src/App.tsx:1:2)" }, local)).toBe(false);
    const app = new Set(["http://127.0.0.1:3000"]);
    // "Script error." says nothing about whose script it was: counted as the app's.
    expect(isThirdPartyError({ message: "Script error." }, app)).toBe(false);
    expect(isThirdPartyError({ message: "x", stack: "Error: x\n    at f (https://cdn.example.com/w.js:1:2)" }, app)).toBe(true);
    expect(isThirdPartyError({ message: "x", stack: "Error: x\n    at f (https://cdn.example.com/w.js:1:2)\n    at g (http://127.0.0.1:3000/app.js:3:4)" }, app)).toBe(false);
    expect(isThirdPartyError({ message: "x", stack: "Error: x\n    at <anonymous>" }, app)).toBe(false);
  });
});

describe("the amend case", () => {
  it(
    "a dialog that closes over a stale list: one diagnosis-only reload shows the save worked",
    async () => {
      const result = await run(
        [{ id: "save", actions: [click("Save in dialog"), waitForText("Ada Lovelace")] }],
        { page: "/stale.html" },
      );
      const failure = result.failure!;
      expect(failure.category).toBe("app");
      expect(failure.reason).toBe("stale screen: the save worked (POST /api/list 200) but the page only showed it after a reload (suspected app bug)");
      expect(failure.changes!.screenChanged).toBe(true);
      expect(failure.changes!.reload).toEqual({ targetShown: true });
      // The reload is the diagnosis's, not the run's: the failing step's recorded impact holds
      // one load of the list (the page's own), the failure frame is the last frame, and
      // failure.json on disk has the reloaded verdict.
      const step = result.manifest.steps[0];
      expect(step.impact.requests.filter((r) => r.path === "/api/list" && r.method === "GET")).toEqual([]);
      expect(result.validation.steps[0].failureFrame).toMatch(/-failure\.png$/);
      expect(JSON.parse(readFileSync(join(result.outDir, "failure.json"), "utf8")).reason).toMatch(/^stale screen/);
    },
    TIMEOUT,
  );

  it("'the screen changed' only when it did", () => {
    const base: FailureChanges = {
      urlBefore: "http://127.0.0.1:3000/r",
      urlAfter: "http://127.0.0.1:3000/r",
      writes: [{ method: "POST", path: "/api/r", status: 200 }],
      errorResponses: [],
      pageErrors: { count: 0 },
      consoleErrors: { count: 0 },
      blankPage: false,
      failedAction: { index: 2, do: "waitFor" },
    };
    const timeout = "locator.waitFor: Timeout 1500ms exceeded.";
    expect(classifyFailure({ error: timeout, phase: "step", changes: base }).reason).not.toMatch(/screen changed/);
    expect(classifyFailure({ error: timeout, phase: "step", changes: { ...base, screenChanged: true } }).reason).toMatch(/and the screen changed/);
    expect(classifyFailure({ error: timeout, phase: "step", changes: { ...base, reload: { targetShown: true } } }).category).toBe("app");
    // The reload couldn't check (the page's socket sends were held back): neither side is blamed.
    expect(classifyFailure({ error: timeout, phase: "step", changes: { ...base, screenChanged: true, reload: { targetShown: false, wsSendsDropped: true } } }).category).toBe("undetermined");
    expect(classifyFailure({ error: timeout, phase: "step", changes: { ...base, screenChanged: true, reload: { targetShown: false } } }).category).toBe("walkthrough");
  });

  it(
    "a save clicked at the end of one step and waited for in the next is still seen",
    async () => {
      const result = await run([
        { id: "click-save", actions: [click("Save registration")] },
        { id: "confirm", actions: [waitForText("Registration saved")] },
      ]);
      const failure = result.failure!;
      expect(failure.step).toBe("confirm");
      expect(failure.changes!.writes).toEqual([{ method: "POST", path: "/api/registrations", status: 200 }]);
      expect(failure.changes!.screenChanged).toBe(false);
      expect(failure.category).toBe("app");
      expect(failure.reason).toMatch(/save request succeeded .* but the screen didn't change/);
    },
    TIMEOUT,
  );

  it(
    "a save still waiting for the server is named, not 'nothing saved'",
    async () => {
      const failure = await fail([click("Save slowly"), waitForText("Registration saved")]);
      expect(failure.changes!.writes[0]).toMatchObject({ method: "POST", path: "/api/slow" });
      expect(failure.changes!.writes[0].status).toBeUndefined();
      expect(failure.reason).toMatch(/a save was still waiting for the server after \d+s \(POST \/api\/slow\)/);
      expect(failure.category).toBe("app");
    },
    TIMEOUT,
  );

  it(
    "a hidden element shown counts as a screen change (cheap fingerprint)",
    async () => {
      const failure = await fail([click("Show hidden"), waitForText("Never shown")]);
      expect(failure.changes!.screenChanged).toBe(true);
    },
    TIMEOUT,
  );
});

describe("redirects, 403s and blank pages", () => {
  it(
    "a redirect away from the start page before anything worked: a missing precondition",
    async () => {
      const failure = await fail([{ do: "expect", target: { role: "heading", name: "Dashboard" } }], { page: "/dashboard" });
      expect(failure.category).toBe("environment");
      expect(failure.reason).toBe(
        "the app sent the browser to /select-show instead of /dashboard: something the walkthrough needs isn't set up (add a `needs:` state with a setup hook, or a setup step)",
      );
      expect(failure.changes!.expectedPath).toBe("/dashboard");
      // The query (`?message=...`) never reaches the report.
      expect(failure.url).toBe(`${server.url}/select-show`);
    },
    TIMEOUT,
  );

  it(
    "a redirect to the sign-in page is reported as a sign-in problem",
    async () => {
      const failure = await fail([{ do: "expect", target: { role: "heading", name: "Reports" } }], { page: "/reports" });
      expect(failure.category).toBe("environment");
      expect(failure.reason).toMatch(/^the app sent the browser to its sign-in page \(\/login\) instead of \/reports/);
    },
    TIMEOUT,
  );

  it(
    "a 403 on a page load points at the persona",
    async () => {
      const failure = await fail([{ do: "goto", path: "/forbidden" }, { do: "expect", target: { role: "button", name: "Edit" } }]);
      expect(failure.changes!.errorResponses).toEqual([{ method: "GET", path: "/forbidden", status: 403 }]);
      expect(failure.category).toBe("walkthrough");
      expect(failure.reason).toMatch(/refused this for admin \(GET \/forbidden 403\).*wrong person/);
    },
    TIMEOUT,
  );

  it(
    "/settings/auth is not a sign-in page",
    async () => {
      const failure = await fail([{ do: "expect", target: { text: "Missing" } }], { page: "/settings/auth" });
      expect(failure.category).toBe("walkthrough");
      expect(isSignInPath("/settings/auth")).toBe(false);
      expect(isSignInPath("/admin/login-history")).toBe(false);
      for (const p of ["/login", "/sign-in", "/signin", "/users/sign_in", "/auth/callback", "/en/login", "http://x/login?next=/a"]) {
        expect(isSignInPath(p), p).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "a loading skeleton is not a blank page",
    async () => {
      const failure = await fail([click("Load slowly"), waitForText("Registration saved")]);
      expect(failure.changes!.blankPage).toBe(false);
      expect(failure.category).toBe("walkthrough");
    },
    TIMEOUT,
  );
});

describe("redaction", () => {
  it(
    "opaque path segments are stripped from the report's URLs",
    async () => {
      const failure = await fail([{ do: "expect", target: { text: "Missing" } }], { page: `/invite/${TOKEN}` });
      expect(failure.url).toBe(`${server.url}/invite/[token]`);
      expect(JSON.stringify(failure)).not.toContain(TOKEN);
    },
    TIMEOUT,
  );

  it("the error line is redacted too", () => {
    const f = runLevelFailure(
      new Error(
        `request failed: Authorization: Bearer abcdefghijklmnop1234567890 for http://127.0.0.1:3000/invite/${TOKEN}?t=1 with sk_live_abcdefghij123456 via postgresql://owner:hunter2@db.local/app\nsecond line`,
      ),
    );
    expect(f.error).not.toMatch(/abcdefghijklmnop1234567890|sk_live_abcdefghij|hunter2|second line|\?t=1/);
    expect(f.error).toContain("/invite/[token]");
    expect(f.error).toContain("@db.local/app");
  });
});

describe("manifest: what was really on screen", () => {
  it(
    "records each acted element's accessible name and the page headings, the same on every run",
    async () => {
      const steps: Step[] = [
        { id: "show", actions: [{ do: "click", target: { role: "button", name: "show hidden" } }] },
      ];
      const a = await run(steps);
      const b = await run(steps);
      expect(a.failure).toBeUndefined();
      // The resolved name ("Show hidden"), not the walkthrough's search string ("show hidden").
      expect(a.manifest.steps[0].seen).toEqual(["Contact details", "New registration", "Show hidden"]);
      expect(b.manifest.steps[0].seen).toEqual(a.manifest.steps[0].seen);
    },
    TIMEOUT,
  );
});
