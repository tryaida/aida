import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig, ResolvedStateConfig, SignInAdapter } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

// Same headroom as capture.test.ts: each test drives a real Chromium.
const TIMEOUT = 90_000;

interface Api {
  count: number;
  posts: { cookie: string; url: string }[];
}

let server: FixtureServer;
let api: Api;
const tmpDirs: string[] = [];

/** `/api/things`: GET returns `{ count }`, POST adds one and records who asked. */
function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith("/api/things")) return false;
  if (req.method === "POST") {
    api.count += 1;
    api.posts.push({ cookie: req.headers.cookie ?? "", url: req.url });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ count: api.count }));
  return true;
}

beforeEach(async () => {
  api = { count: 0, posts: [] };
  server = await startFixtureServer(handleApi);
}, TIMEOUT);

afterEach(async () => {
  await server.close();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-states-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Signs in by setting a cookie naming the role, so the API can tell sessions apart. */
const signIn: SignInAdapter = async ({ context, baseUrl, persona }) => {
  await context.addCookies([{ name: "session", value: persona?.role ?? "anon", url: baseUrl }]);
};

function config(states: Record<string, ResolvedStateConfig> = {}): ResolvedConfig {
  return {
    app: { baseUrl: server.url },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    signIn,
    states,
  };
}

function walkthrough(extra: Partial<Walkthrough> = {}): Walkthrough {
  return {
    walkthrough: "see-things",
    title: "See things",
    start: { page: "/states.html", persona: { role: "staff" }, signed_in_as: "staff" },
    steps: [{ id: "see-one", actions: [{ do: "expect", target: { text: "Things: 1" } }] }],
    ...extra,
  };
}

const thingCount = async (ctx: { request: { get(url: string): Promise<{ json(): Promise<unknown> }> } }): Promise<number> =>
  ((await (await ctx.request.get("/api/things")).json()) as { count: number }).count;

describe("capture setup phase", () => {
  it(
    "check -> setup -> check for a need, with the state's own role and the API session",
    async () => {
      const calls: string[] = [];
      const states: Record<string, ResolvedStateConfig> = {
        "thing-exists": {
          as: "admin",
          check: async (ctx) => {
            calls.push("check");
            return (await thingCount(ctx)) > 0;
          },
          setup: async (ctx) => {
            calls.push("setup");
            await ctx.request.post("/api/things");
          },
        },
      };
      const outDir = tmpDir();
      const result = await runCapture({ walkthrough: walkthrough({ needs: ["thing-exists"] }), config: config(states), outDir });

      expect(calls).toEqual(["check", "setup", "check"]);
      expect(result.validation.ok).toBe(true);
      expect(result.setup?.needs).toEqual([{ state: "thing-exists", outcome: "set-up" }]);
      // The hook's API call carried the admin session, not the walkthrough's staff one.
      expect(api.posts).toHaveLength(1);
      expect(api.posts[0].cookie).toContain("session=admin");

      // A second capture finds the state already true and doesn't set it up again.
      calls.length = 0;
      const again = await runCapture({ walkthrough: walkthrough({ needs: ["thing-exists"] }), config: config(states), outDir: tmpDir() });
      expect(calls).toEqual(["check"]);
      expect(again.setup?.needs[0].outcome).toBe("held");
      expect(api.count).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "runs setup steps unrecorded: nothing from them in the manifest or frames, {{run.id}} filled in",
    async () => {
      const outDir = tmpDir();
      const setupSteps = [
        { id: "open", actions: [{ do: "goto" as const, path: "/states.html?tag={{run.id}}" }] },
        { id: "add", actions: [{ do: "click" as const, target: { role: "button", name: "Add thing" } }] },
        { id: "added", actions: [{ do: "expect" as const, target: { text: "Things: 1" } }] },
      ];
      const result = await runCapture({
        walkthrough: walkthrough({ setup: { steps: setupSteps } }),
        config: config(),
        outDir,
        runId: "abc123",
      });

      expect(result.failure).toBeUndefined();
      expect(result.validation.ok).toBe(true);
      expect(result.setup?.setupSteps).toBe(3);
      expect(api.posts.map((p) => p.url)).toEqual(["/api/things?tag=abc123"]);
      expect(api.posts[0].cookie).toContain("session=staff");
      // Only the walkthrough's own step is recorded.
      expect(result.manifest.steps.map((s) => s.id)).toEqual(["see-one"]);
      expect(result.validation.steps.map((s) => s.id)).toEqual(["see-one"]);
      const recorded = new Set(result.manifest.steps.flatMap((s) => s.events.flatMap((e) => (e.type === "frame" ? [e.image] : []))));
      expect(readdirSync(join(outDir, "frames")).sort()).toEqual([...recorded].sort());
    },
    TIMEOUT,
  );

  it(
    "fails with a setup error, before recording anything, when a need's check is false and it has no setup",
    async () => {
      const outDir = tmpDir();
      const result = await runCapture({
        walkthrough: walkthrough({ needs: ["thing-exists"] }),
        config: config({ "thing-exists": { check: async (ctx) => (await thingCount(ctx)) > 0 } }),
        outDir,
      });
      expect(result.validation.ok).toBe(false);
      expect(result.manifest.steps).toEqual([]);
      expect(result.failure).toMatchObject({ action: "setup", step: "needs thing-exists" });
      expect(result.failure?.error).toContain("its check says it isn't true");
      // Nothing leaves it: it's starting data, so the advice is to reset or add a setup hook.
      expect(result.failure?.error).toContain("this is starting data");
      expect(result.failure?.error).toContain("reset the demo data");
      expect(result.failure?.error).not.toContain("capture a walkthrough that leaves it first");
      expect(JSON.parse(readFileSync(join(outDir, "failure.json"), "utf8")).action).toBe("setup");
      expect(readdirSync(join(outDir, "frames"))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "names the walkthrough that leaves a need whose check is false, and pins setup pages to config.clock",
    async () => {
      const wdir = tmpDir();
      writeFileSync(join(wdir, "add-thing.yaml"), "walkthrough: add-thing\ntitle: Add\nleaves: [thing-exists]\nsteps:\n  - do: go to /x\n");
      const seen: string[] = [];
      const result = await runCapture({
        walkthrough: walkthrough({ needs: ["thing-exists"] }),
        config: {
          ...config({
            "thing-exists": {
              check: async (ctx) => {
                seen.push(await ctx.page.evaluate(() => new Date().toISOString()));
                return false;
              },
            },
          }),
          walkthroughsDir: wdir,
          clock: "2026-03-04T05:06:07.000Z",
        },
        outDir: tmpDir(),
      });
      expect(result.failure?.error).toContain("capture add-thing first");
      expect(seen[0]?.slice(0, 16)).toBe("2026-03-04T05:06");
    },
    TIMEOUT,
  );

  it(
    "warns when a state it should leave doesn't hold afterwards",
    async () => {
      const result = await runCapture({
        walkthrough: walkthrough({ leaves: ["two-things"], steps: [{ id: "look", actions: [{ do: "expect", target: { text: "Things: 0" } }] }] }),
        config: config({ "two-things": { check: async (ctx) => (await thingCount(ctx)) >= 2 } }),
        outDir: tmpDir(),
      });
      expect(result.validation.ok).toBe(true);
      expect(result.warnings).toEqual(["see-things should leave two-things, but its check says it isn't true afterwards"]);
    },
    TIMEOUT,
  );
});

describe("aida capture with data states", () => {
  function writeProject(providerFails = true): string {
    const dir = tmpDir();
    mkdirSync(join(dir, "walkthroughs"), { recursive: true });
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n`,
    );
    const write = (name: string, extra: string, expectText: string): void =>
      writeFileSync(
        join(dir, "walkthroughs", `${name}.yaml`),
        `walkthrough: ${name}\ntitle: ${name}\nstart:\n  page: /states.html\n${extra}steps:\n  - id: look\n    check: 'text "${expectText}" is visible'\n`,
      );
    // A failing provider's check text never appears, so nothing leaves `thing-exists`.
    write("add-thing", "leaves: [thing-exists]\n", providerFails ? "Never shown" : "Things: 0");
    // (The fixture's provider doesn't really add a thing, so a passing run looks for "Things: 0".)
    write("see-thing", "needs: [thing-exists]\n", providerFails ? "Things: 1" : "Things: 0");
    write("other", "", "Things: 0");
    return dir;
  }

  async function captureJson(dir: string, ids: string[], withDeps = false): Promise<{ code: number; out: { walkthroughs: { walkthrough: string; ok: boolean; skipped?: string; dependency?: boolean }[]; problems?: string[] } }> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    try {
      const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: ids, json: true, withDeps });
      return { code, out: JSON.parse(logs[logs.length - 1]) };
    } finally {
      spy.mockRestore();
    }
  }

  it(
    "captures the provider first and skips its dependant when the provider fails",
    async () => {
      const dir = writeProject();
      const { code, out } = await captureJson(dir, ["see-thing", "add-thing", "other"]);
      expect(code).toBe(1);
      expect(out.walkthroughs.map((w) => w.walkthrough)).toEqual(["add-thing", "see-thing", "other"]);
      expect(out.walkthroughs[0].ok).toBe(false);
      expect(out.walkthroughs[1]).toMatchObject({ ok: false, skipped: "skipped: needs thing-exists, which add-thing didn't leave" });
      expect(out.walkthroughs[2].ok).toBe(true);
      expect(existsSync(join(dir, ".build", "see-thing", "capture", "manifest.json"))).toBe(false);
      // The skipped one's capture dir says so, so build --skip-capture refuses it.
      const v = JSON.parse(readFileSync(join(dir, ".build", "see-thing", "capture", "validation.json"), "utf8"));
      expect(v).toMatchObject({ ok: false, notCaptured: "skipped: needs thing-exists, which add-thing didn't leave" });
    },
    TIMEOUT,
  );

  it("refuses to start when a need has no provider in the run, naming it; --with-deps pulls it in", async () => {
    const dir = writeProject(false);
    const refused = await captureJson(dir, ["see-thing"]);
    expect(refused.code).toBe(1);
    expect(refused.out.problems?.[0]).toContain("see-thing needs thing-exists, but nothing else in this run leaves it: add add-thing");
    // Reported as blocked with the reason, not a run that never started.
    expect(refused.out.walkthroughs).toHaveLength(1);
    expect(refused.out.walkthroughs[0].skipped).toMatch(/^blocked: see-thing needs thing-exists/);

    const pulled = await captureJson(dir, ["see-thing"], true);
    expect(pulled.out.walkthroughs.map((w) => [w.walkthrough, Boolean(w.dependency)])).toEqual([
      ["add-thing", true],
      ["see-thing", false],
    ]);
  }, TIMEOUT);
});
