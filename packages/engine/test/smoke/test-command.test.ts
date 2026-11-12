// `aida test`: walkthroughs replayed against fixture pages over HTTP and reported like a test run:
// pass, a broken step, an app problem on a replay whose steps all passed, a blocked dependant,
// --bail, --json, JUnit XML that parses and escapes the app's own text, exit codes, the safety
// gate, --affected, and the help site's captures left alone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runTestCommand, type RunTestCommandOptions } from "../../src/commands/test.js";
import type { TestRunResult } from "../../src/smoke/types.js";
import { startFixtureServer, type FixtureServer } from "../capture/fixture-server.js";

const HOSTILE = `bad </failure> & "quote" <x> ]]> \u0001 end`;

const PAGES: Record<string, string> = {
  "/ok": `<!doctype html><html><body><main><h1>Things</h1>
    <button onclick="document.getElementById('msg').textContent='Added'">Add</button><p id="msg"></p></main></body></html>`,
  "/broken": `<!doctype html><html><body><main><h1>Nothing to do</h1><p id="plain">Just text</p></main></body></html>`,
  "/app": `<!doctype html><html><body><main><h1>Send it</h1>
    <button onclick="send()">Send</button><p id="msg"></p></main>
    <script>
      function send() {
        fetch("/api/boom", { method: "POST" });
        document.getElementById("msg").textContent = "Sent";
        setTimeout(() => { throw new Error(${JSON.stringify(HOSTILE)}); }, 0);
      }
    </script></body></html>`,
};

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/api/boom") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
    return true;
  }
  const page = PAGES[path];
  if (!page) return false;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
  return true;
}

const WALKTHROUGHS: Record<string, string> = {
  "ok-one": `walkthrough: ok-one
title: Add a thing
start: { page: /ok }
steps:
  - id: add
    title: Add it
    do: click "Add" button
  - id: see
    title: See it added
    check: expect text "Added"
`,
  // Focus on plain text fails at once: a walkthrough problem, no long wait.
  "broken-one": `walkthrough: broken-one
title: Get ready
start: { page: /broken }
leaves: [thing-ready]
steps:
  - id: look
    title: Look at the page
    check: expect text "Nothing to do"
  - id: focus-text
    title: Focus the text
    actions:
      - do: focus
        target: { css: "#plain" }
  - id: never
    title: Never reached
    check: expect text "Just text"
`,
  "app-one": `walkthrough: app-one
title: Send something
start: { page: /app }
steps:
  - id: send
    title: Send it
    do: click "Send" button
  - id: sent
    title: See it sent
    check: expect text "Sent"
`,
  "needs-thing": `walkthrough: needs-thing
title: Use the thing
start: { page: /ok }
needs: [thing-ready]
steps:
  - id: use
    title: Use it
    check: expect text "Things"
`,
};

let server: FixtureServer;
const dirs: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer(handle);
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(ids: string[], appExtra = ""): { dir: string; config: string; buildDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aida-test-command-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  for (const id of ids) writeFileSync(join(dir, "walkthroughs", `${id}.yaml`), WALKTHROUGHS[id]);
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default {
      app: { baseUrl: ${JSON.stringify(server.url)}${appExtra} },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
    };\n`,
  );
  return { dir, config: join(dir, "aida.config.mjs"), buildDir: join(dir, ".build") };
}

/** Runs the command, returning its exit code and what it printed. */
async function run(opts: RunTestCommandOptions): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  try {
    const code = await runTestCommand(opts);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    vi.restoreAllMocks();
  }
}

/** Parses XML in a real browser: the parser CI tools use is just as strict. */
async function parseXml(xml: string): Promise<{ error: string | null; suites: { name: string; cases: { name: string; failure: { type: string; message: string; text: string } | null; skipped: boolean }[] }[] }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      const error = doc.querySelector("parsererror")?.textContent ?? null;
      const suites = [...doc.querySelectorAll("testsuite")].map((s) => ({
        name: s.getAttribute("name") ?? "",
        cases: [...s.querySelectorAll("testcase")].map((c) => {
          const f = c.querySelector("failure");
          return {
            name: c.getAttribute("name") ?? "",
            failure: f ? { type: f.getAttribute("type") ?? "", message: f.getAttribute("message") ?? "", text: f.textContent ?? "" } : null,
            skipped: Boolean(c.querySelector("skipped")),
          };
        }),
      }));
      return { error, suites };
    }, xml);
  } finally {
    await browser.close();
  }
}

describe("aida test", () => {
  let all: { code: number; out: string; result: TestRunResult; xml: string; dir: string; buildDir: string; docsBefore: Record<string, string> };

  beforeAll(async () => {
    const { dir, config, buildDir } = project(["ok-one", "broken-one", "app-one", "needs-thing"]);
    // The help site's own capture of ok-one, which a test run must leave exactly as it is.
    const docs = join(buildDir, "ok-one", "capture");
    mkdirSync(docs, { recursive: true });
    const docsBefore = { "manifest.json": '{"workflow":"ok-one","from":"aida build"}\n', "validation.json": '{"workflow":"ok-one","ok":true}\n' };
    for (const [f, text] of Object.entries(docsBefore)) writeFileSync(join(docs, f), text);
    const junit = join(dir, "reports", "aida.xml");
    const { code, out } = await run({ configPath: config, walkthroughIds: [], json: true, junit });
    all = { code, out, result: JSON.parse(out), xml: readFileSync(junit, "utf8"), dir, buildDir, docsBefore };
  }, 180_000);

  it("reports each walkthrough as passed, broken, an app problem or blocked, and exits 1", () => {
    expect(all.code).toBe(1);
    const byId = Object.fromEntries(all.result.walkthroughs.map((r) => [r.walkthrough, r]));
    expect(Object.keys(byId).sort()).toEqual(["app-one", "broken-one", "needs-thing", "ok-one"]);
    expect(byId["ok-one"]).toMatchObject({ status: "passed", steps: [{ title: "Add it", status: "passed" }, { title: "See it added", status: "passed" }] });
    expect(byId["ok-one"].failure).toBeUndefined();

    // The failing step, the reason from the failure report, and where its screenshot and report are.
    const broken = byId["broken-one"];
    expect(broken.status).toBe("broken");
    expect(broken.steps.map((s) => s.status)).toEqual(["passed", "failed", "skipped"]);
    expect(broken.failure).toMatchObject({ step: "focus-text", action: "focus", category: "walkthrough" });
    expect(broken.failure!.summary).toContain('step "focus-text"');
    expect(broken.failure!.reason).toBeTruthy();
    expect(broken.failure!.report).toBe(join(all.buildDir, "broken-one", "ci", "capture", "failure.json"));
    expect(existsSync(broken.failure!.report!)).toBe(true);
    expect(broken.failure!.screenshot).toBeTruthy();
    expect(existsSync(broken.failure!.screenshot!)).toBe(true);
    expect(broken.failure!.repairCommand).toContain("aida-repair");

    // Every step passed, but the app answered a 5xx and threw: an app problem, which fails the run.
    const app = byId["app-one"];
    expect(app.status).toBe("app");
    expect(app.steps.every((s) => s.status === "passed")).toBe(true);
    expect(app.failure).toMatchObject({ category: "app" });
    expect(app.failure!.reason).toContain("suspected app bug");
    expect(app.failure!.repairCommand).toBeUndefined();

    expect(byId["needs-thing"]).toMatchObject({ status: "blocked", failure: { blockedBy: ["broken-one"] }, steps: [{ status: "skipped" }] });
    expect(all.result.counts).toEqual({ passed: 1, broken: 1, app: 1, environment: 0, undetermined: 0, blocked: 1 });
    expect(all.result.ok).toBe(false);
    expect(all.result.notRun).toEqual([]);
  });

  it("writes JUnit XML that parses, one suite per walkthrough and one case per step, failures typed", async () => {
    const parsed = await parseXml(all.xml);
    expect(parsed.error).toBeNull();
    const suites = Object.fromEntries(parsed.suites.map((s) => [s.name, s]));
    expect(suites["ok-one"].cases.map((c) => [c.name, c.failure, c.skipped])).toEqual([
      ["1. Add it", null, false],
      ["2. See it added", null, false],
    ]);
    expect(suites["broken-one"].cases.map((c) => [c.name, c.failure?.type ?? null, c.skipped])).toEqual([
      ["1. Look at the page", null, false],
      ["2. Focus the text", "walkthrough", false],
      ["3. Never reached", null, true],
    ]);
    const appFailure = suites["app-one"].cases.find((c) => c.failure)!.failure!;
    expect(appFailure.type).toBe("app");
    expect(suites["needs-thing"].cases[0].failure?.type).toBe("blocked");
    expect(suites["needs-thing"].cases[1]).toMatchObject({ name: "1. Use it", skipped: true });
  });

  it("escapes the app's own text in the XML", async () => {
    // The page error's text reaches the report, escaped: no raw markup, no control character.
    expect(all.xml).not.toContain("</failure> &");
    expect(all.xml).not.toContain("\u0001");
    const parsed = await parseXml(all.xml);
    const app = parsed.suites.find((s) => s.name === "app-one")!.cases.find((c) => c.failure)!.failure!;
    expect(`${app.message}\n${app.text}`).toContain('bad </failure> & "quote" <x> ]]>');
  });

  it("leaves the help site's captures alone and replays into aida ci's folder", () => {
    for (const [f, text] of Object.entries(all.docsBefore)) expect(readFileSync(join(all.buildDir, "ok-one", "capture", f), "utf8")).toBe(text);
    expect(existsSync(join(all.buildDir, "broken-one", "capture"))).toBe(false);
    expect(existsSync(join(all.buildDir, "ok-one", "ci", "capture", "validation.json"))).toBe(true);
    expect(all.result.captures).toBe(join(all.buildDir, "<walkthrough>", "ci"));
  });

  it("prints a short summary and exits 0 when everything passed", async () => {
    const { config } = project(["ok-one"]);
    const { code, out } = await run({ configPath: config, walkthroughIds: ["ok-one"] });
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual(["aida test: 1 walkthrough: 1 passed", "  passed  ok-one  2/2 steps"]);
  }, 60_000);

  it("--bail stops at the first walkthrough that doesn't pass", async () => {
    const { config } = project(["broken-one", "ok-one"]);
    const { code, out } = await run({ configPath: config, walkthroughIds: ["broken-one", "ok-one"], bail: true, json: true });
    expect(code).toBe(1);
    const result = JSON.parse(out) as TestRunResult;
    expect(result.walkthroughs.map((r) => r.walkthrough)).toEqual(["broken-one"]);
    expect(result.notRun).toEqual(["ok-one"]);
  }, 60_000);

  it("names the failing step, its reason and files in the summary", async () => {
    const { config } = project(["broken-one"]);
    const { code, out } = await run({ configPath: config, walkthroughIds: ["broken-one"] });
    expect(code).toBe(1);
    const lines = out.split("\n");
    expect(lines[0]).toBe("aida test: 1 walkthrough: 1 broken");
    expect(lines[1]).toBe("  broken  broken-one  1/3 steps");
    expect(out).toContain('step "focus-text"');
    expect(out).toMatch(/why: .+/);
    expect(out).toMatch(/screenshot: .+\.png/);
    expect(out).toMatch(/report: .+broken-one\/ci\/capture\/failure\.json/);
  }, 60_000);

  it("the safety gate still refuses a database that isn't on this machine, before any browser opens", async () => {
    const { dir, config, buildDir } = project(["ok-one"], `, database: { url: "postgres://demo:pw@db.example.com:5432/prod" }`);
    const junit = join(dir, "aida.xml");
    const { code, out } = await run({ configPath: config, walkthroughIds: [], json: true, junit });
    expect(code).toBe(1);
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/db\.example\.com|database/i);
    expect(payload.database).toBeTruthy();
    expect(JSON.stringify(payload)).not.toContain("pw@");
    expect(existsSync(join(buildDir, "ok-one", "ci"))).toBe(false);
    expect((await parseXml(readFileSync(junit, "utf8"))).suites[0].cases[0].failure?.type).toBe("environment");
  }, 60_000);

  it("--affected replays only the walkthroughs the diff touches", async () => {
    const { dir, config, buildDir } = project(["ok-one", "broken-one"]);
    // Both captured before, so neither is affected just for having no capture.
    for (const id of ["ok-one", "broken-one"]) {
      mkdirSync(join(buildDir, id, "capture"), { recursive: true });
      writeFileSync(join(buildDir, id, "capture", "manifest.json"), JSON.stringify({ workflow: id, baseUrl: server.url, viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, steps: [] }));
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, ".gitignore"), ".build/\n");
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "walkthroughs", "ok-one.yaml"), WALKTHROUGHS["ok-one"].replace("title: Add a thing", "title: Add one thing"));
    git("commit", "-q", "-am", "change ok-one");

    const { code, out } = await run({ configPath: config, walkthroughIds: [], json: true, affected: true, base: "HEAD~1", appRepo: dir });
    const result = JSON.parse(out) as TestRunResult;
    expect(result.affected).toMatchObject({ base: "HEAD~1", head: "HEAD", all: false });
    expect(result.walkthroughs.map((r) => r.walkthrough)).toEqual(["ok-one"]);
    expect(code).toBe(0);
  }, 60_000);

  it("bad usage exits 2 without running anything", async () => {
    const { config } = project(["ok-one"]);
    expect((await run({ configPath: config, walkthroughIds: [], affected: true })).code).toBe(2);
    expect((await run({ configPath: config, walkthroughIds: [], base: "main" })).code).toBe(2);
  });

  it("an unknown walkthrough is an error, exit 1", async () => {
    const { config } = project(["ok-one"]);
    const { code, err } = await run({ configPath: config, walkthroughIds: ["nope"] });
    expect(code).toBe(1);
    expect(err).toContain('no walkthrough "nope"');
  });
});
