// M28 (decision 30): the failure report says what changed during the failing step and whether it
// looks like a walkthrough, app or environment problem. Each case drives a real Chromium against
// test/capture/fixture/diagnose.html, whose buttons stand in for the ways a save can go.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Action, Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { classifyFailure } from "../../src/capture/diagnose.js";
import { failureEvidence, formatFailureLines } from "../../src/capture/failure-report.js";
import type { FailureChanges } from "../../src/capture/types.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
/** Short waits: every case here fails on purpose, and the default waits are 20-60 s. */
const MAX_WAIT_MS = 1_500;

let server: FixtureServer;
const tmpDirs: string[] = [];

function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "").split("?")[0];
  const status = { "/api/registrations": 200, "/api/broken": 500, "/api/invalid": 422 }[path];
  if (status === undefined) return false;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ secret: "response bodies never reach the report" }));
  return true;
}

beforeEach(async () => {
  server = await startFixtureServer(handleApi);
}, TIMEOUT);

afterEach(async () => {
  await server.close();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-diagnose-test-"));
  tmpDirs.push(dir);
  return dir;
}

function config(baseUrl = server.url): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  };
}

function saveWalkthrough(actions: Action[]): Walkthrough {
  return {
    walkthrough: "register",
    title: "Register",
    start: { page: "/diagnose.html", persona: { role: "admin" }, signed_in_as: "admin" },
    steps: [
      { id: "look", actions: [{ do: "expect", target: { role: "heading", name: "New registration" } }] },
      { id: "save", actions },
    ],
  };
}

const click = (name: string): Action => ({ do: "click", target: { role: "button", name } });
const waitForSaved: Action = { do: "waitFor", target: { text: "Registration saved" } };

async function fail(actions: Action[]) {
  const outDir = tmpDir();
  const result = await runCapture({ walkthrough: saveWalkthrough(actions), config: config(), outDir, maxWaitMs: MAX_WAIT_MS });
  expect(result.failure).toBeDefined();
  return { failure: result.failure!, outDir };
}

describe("failure report: what changed, and who it belongs to", () => {
  it(
    "save returns 200 but the screen doesn't change: a suspected app bug, with the evidence",
    async () => {
      const { failure, outDir } = await fail([click("Save registration"), waitForSaved]);
      expect(failure.category).toBe("app");
      expect(failure.reason).toBe(
        "suspected app bug: the save request succeeded (POST /api/registrations 200) but the screen didn't change",
      );
      expect(failure.step).toBe("save");
      // The wait the click consumed is what failed, not the click.
      expect(failure.action).toBe("waitFor");
      const c = failure.changes!;
      expect(c.urlBefore).toBe(`${server.url}/diagnose.html`);
      expect(c.urlAfter).toBe(c.urlBefore);
      expect(c.writes).toEqual([{ method: "POST", path: "/api/registrations", status: 200 }]);
      expect(c.errorResponses).toEqual([]);
      expect(c.screenChanged).toBe(false);
      expect(c.blankPage).toBe(false);
      expect(c.signedInAs).toBe("admin");
      expect(c.failedAction).toEqual({ index: 2, do: "waitFor" });
      expect(c.lastOkAction).toEqual({ index: 1, do: "click" });

      // On disk too, and agent-safe: no query strings, no response bodies.
      const onDisk = readFileSync(join(outDir, "failure.json"), "utf8");
      expect(JSON.parse(onDisk).category).toBe("app");
      expect(onDisk).not.toContain("secret-value");
      expect(onDisk).not.toContain("response bodies");
    },
    TIMEOUT,
  );

  it(
    "a 500 on save: a suspected app bug",
    async () => {
      const { failure } = await fail([click("Save broken"), waitForSaved]);
      expect(failure.category).toBe("app");
      expect(failure.reason).toContain("POST /api/broken 500");
      expect(failure.changes!.errorResponses).toEqual([{ method: "POST", path: "/api/broken", status: 500 }]);
    },
    TIMEOUT,
  );

  it(
    "a missing button: a walkthrough problem (nothing saved, no server error)",
    async () => {
      const { failure } = await fail([click("Does not exist")]);
      expect(failure.category).toBe("walkthrough");
      expect(failure.reason).toMatch(/never found/);
      expect(failure.action).toBe("click");
      expect(failure.changes!.writes).toEqual([]);
      expect(failure.changes!.failedAction).toEqual({ index: 1, do: "click" });
      expect(failure.changes!.lastOkAction).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "a 422 on save: a walkthrough problem, likely a missing field or bad demo data",
    async () => {
      const { failure } = await fail([click("Save invalid"), waitForSaved]);
      expect(failure.category).toBe("walkthrough");
      expect(failure.reason).toContain("POST /api/invalid 422");
      expect(failure.reason).toMatch(/missing required field or bad demo data/);
    },
    TIMEOUT,
  );

  it(
    "a blank page after an action: a suspected app bug",
    async () => {
      const { failure } = await fail([click("Wipe page"), waitForSaved]);
      expect(failure.category).toBe("app");
      expect(failure.changes!.blankPage).toBe(true);
      expect(failure.reason).toBe('suspected app bug: the page went blank after "click"');
    },
    TIMEOUT,
  );

  it(
    "an uncaught page error during the step: a suspected app bug, first line only",
    async () => {
      const { failure } = await fail([click("Crash"), waitForSaved]);
      expect(failure.category).toBe("app");
      expect(failure.changes!.pageErrors.count).toBe(1);
      expect(failure.changes!.pageErrors.first).toMatch(/Cannot read properties of undefined/);
    },
    TIMEOUT,
  );

  it(
    "a save that changes the screen, but not as expected: the walkthrough",
    async () => {
      const { failure } = await fail([click("Save and show"), { do: "waitFor", target: { text: "Something else" } }]);
      expect(failure.category).toBe("walkthrough");
      expect(failure.changes!.screenChanged).toBe(true);
    },
    TIMEOUT,
  );
});

describe("environment failures through aida capture", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function project(baseUrl: string, extra = ""): string {
    const dir = tmpDir();
    mkdirSync(join(dir, "walkthroughs"));
    writeFileSync(
      join(dir, "walkthroughs", "one.yaml"),
      "walkthrough: one\ntitle: t\nstart:\n  page: /\nsteps:\n  - id: s\n    actions:\n      - do: expect\n        target:\n          text: x\n",
    );
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { app: { baseUrl: ${JSON.stringify(baseUrl)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", ${extra} };`,
    );
    return join(dir, "aida.config.mjs");
  }

  it(
    "an unreachable baseUrl is an environment problem, in JSON and in text",
    async () => {
      // A port nothing listens on: open one, then close it.
      const closed = await startFixtureServer();
      await closed.close();
      const configPath = project(closed.url);
      expect(await runCaptureCommand({ configPath, walkthroughIds: [], json: true })).toBe(1);
      const failure = JSON.parse(logs[0]).walkthroughs[0].failure;
      expect(failure.category).toBe("environment");
      expect(failure.reason).toMatch(/couldn't reach the app/);

      logs.length = 0;
      expect(await runCaptureCommand({ configPath, walkthroughIds: [], json: false })).toBe(1);
      expect(logs.join("\n")).toMatch(/looks like: environment problem \(not the walkthrough\): couldn't reach the app/);
    },
    TIMEOUT,
  );

  it(
    "a sign-in failure is an environment problem",
    async () => {
      const configPath = project(server.url, `signIn: async () => { throw new Error("sign-in failed (HTTP 401)"); },`);
      expect(await runCaptureCommand({ configPath, walkthroughIds: [], json: true })).toBe(1);
      const failure = JSON.parse(logs[0]).walkthroughs[0].failure;
      expect(failure).toMatchObject({ category: "environment", action: "sign-in", error: "sign-in failed (HTTP 401)" });
      expect(failure.reason).toMatch(/signing in failed/);
    },
    TIMEOUT,
  );
});

describe("classifyFailure (pure)", () => {
  const changes = (extra: Partial<FailureChanges> = {}): FailureChanges => ({
    urlBefore: "http://127.0.0.1:3000/registrations/new",
    urlAfter: "http://127.0.0.1:3000/registrations/new",
    writes: [],
    errorResponses: [],
    pageErrors: { count: 0 },
    consoleErrors: { count: 0 },
    blankPage: false,
    ...extra,
  });
  const timeout = "locator.waitFor: Timeout 60000ms exceeded.";

  it("a 401 on a write, or a bounce to sign-in mid-step, is the environment", () => {
    expect(
      classifyFailure({ error: timeout, phase: "step", changes: changes({ writes: [{ method: "POST", path: "/api/x", status: 401 }] }) }).category,
    ).toBe("environment");
    expect(classifyFailure({ error: timeout, phase: "step", changes: changes({ urlAfter: "http://127.0.0.1:3000/sign-in" }) }).category).toBe(
      "environment",
    );
  });

  it("a 403 on a write points at the persona, as a walkthrough problem", () => {
    const c = classifyFailure({
      error: timeout,
      phase: "step",
      changes: changes({ writes: [{ method: "POST", path: "/api/x", status: 403 }], signedInAs: "viewer" }),
    });
    expect(c.category).toBe("walkthrough");
    expect(c.reason).toMatch(/for viewer/);
  });

  it("the amend case needs the URL and the screen both unchanged", () => {
    const saved = { writes: [{ method: "POST", path: "/api/registrations", status: 200 }], failedAction: { index: 2, do: "waitFor" } };
    expect(classifyFailure({ error: timeout, phase: "step", changes: changes({ ...saved, screenChanged: false }) }).category).toBe("app");
    expect(classifyFailure({ error: timeout, phase: "step", changes: changes({ ...saved, screenChanged: true }) }).category).toBe(
      "walkthrough",
    );
    expect(
      classifyFailure({ error: timeout, phase: "step", changes: changes({ ...saved, screenChanged: false, urlAfter: "http://127.0.0.1:3000/registrations/7" }) })
        .category,
    ).toBe("walkthrough");
  });

  it("setup, safety refusals and a browser that won't start are the environment", () => {
    expect(classifyFailure({ error: "setup step \"seed\" failed: boom", phase: "setup" }).category).toBe("environment");
    expect(classifyFailure({ error: "refusing to run write steps against non-local baseUrl https://x.example.com", phase: "run" }).reason).toMatch(
      /safety check/,
    );
    expect(classifyFailure({ error: "browserType.launch: Executable doesn't exist at /x", phase: "run" }).reason).toMatch(/aida doctor/);
  });

  it("evidence and text lines stay short", () => {
    const report = {
      step: "save",
      action: "waitFor",
      category: "app" as const,
      reason: "suspected app bug",
      error: timeout,
      url: "http://127.0.0.1:3000/registrations/new",
      changes: changes({ writes: [{ method: "POST", path: "/api/registrations", status: 200 }], screenChanged: false, signedInAs: "admin" }),
      snapshot: "",
      screenshotPath: null,
    };
    expect(failureEvidence(report)).toBe(
      "URL /registrations/new (unchanged); writes: POST /api/registrations 200; screen unchanged; signed in as admin",
    );
    expect(formatFailureLines(report)[2]).toBe("looks like: possible app bug (not a docs problem): suspected app bug");
  });
});
