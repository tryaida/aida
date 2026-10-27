import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __createdTmpDirs: string[] = [];

let server: FixtureServer;

// Each test below drives a real Chromium via runCapture, which launches its own browser and
// closes it in a `finally` — so one slow/contended test never leaves a browser running into the
// next. Under machine load (several Playwright-backed test files' browsers contending for CPU at
// once — the known flaky timeout 3 builders hit, docs/build-plan.md log) the per-test timeouts
// below need real headroom, not the vitest default.
const CAPTURE_TEST_TIMEOUT = 90_000;

beforeEach(async () => {
  server = await startFixtureServer();
}, CAPTURE_TEST_TIMEOUT);

afterEach(async () => {
  await server.close();
  while (__createdTmpDirs.length) rmSync(__createdTmpDirs.pop()!, { recursive: true, force: true });
}, CAPTURE_TEST_TIMEOUT);

function baseConfig(baseUrl: string): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
  };
}

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("runCapture", () => {
  it(
    "replays click/type/expect/scrollTo/goto actions, resolves {{data}} templates, and writes frames",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-add-thing",
        title: "Add a thing",
        start: { page: "/" },
        data: { person: { name: "Ada Lovelace", email: "ada.lovelace@example.com" } },
        steps: [
          {
            id: "enter-name",
            actions: [
              { do: "click", target: { label: "First name" } },
              { do: "type", target: { label: "First name" }, text: "{{person.name}}" },
            ],
          },
          {
            id: "enter-email",
            mask: ["Email"],
            actions: [
              { do: "click", target: { label: "Email" } },
              { do: "type", target: { label: "Email" }, text: "{{person.email}}" },
            ],
          },
          {
            id: "submit",
            actions: [
              { do: "scrollTo", target: { role: "button", name: "Add thing" } },
              { do: "click", target: { role: "button", name: "Add thing" } },
              { do: "expect", target: { text: "Added: Ada Lovelace" } },
            ],
          },
          {
            id: "go-to-success",
            actions: [
              { do: "goto", path: "/success.html" },
              { do: "expect", target: { role: "heading", name: "Success" } },
            ],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir });

      expect(result.validation.ok).toBe(true);
      expect(result.validation.steps).toHaveLength(4);
      expect(result.validation.steps.every((s) => s.ok)).toBe(true);
      expect(result.manifest.steps).toHaveLength(4);
      expect(result.manifest.finalUrl).toBe(`${server.url}/success.html`);

      // the typed text was resolved from {{person.name}} / {{person.email}} before typing
      const nameStep = result.manifest.steps.find((s) => s.id === "enter-name");
      const typeCheck = nameStep?.checks.find((c) => "type" in c) as { text?: string } | undefined;
      expect(typeCheck?.text).toBe("Ada Lovelace");

      // frames were written to disk
      const frameFiles = readdirSync(join(outDir, "frames"));
      expect(frameFiles.length).toBeGreaterThan(0);
      for (const step of result.manifest.steps) {
        for (const event of step.events) {
          if (event.type === "frame") expect(frameFiles).toContain(event.image);
        }
      }

      // aida's additions: impact and checks are present on every step
      for (const step of result.manifest.steps) {
        expect(step.impact).toBeDefined();
        expect(Array.isArray(step.checks)).toBe(true);
      }
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "produces a byte-identical manifest.json across two identical runs (bug: capturedAt made every run differ)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-determinism",
        title: "Determinism check",
        start: { page: "/" },
        steps: [{ id: "noop", actions: [{ do: "expect", target: { text: "Capture fixture" } }] }],
      };

      const r1 = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      await new Promise((r) => setTimeout(r, 50)); // force wall-clock to move between runs
      const r2 = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      expect(JSON.stringify(r1.manifest)).toBe(JSON.stringify(r2.manifest));
      // The wall-clock metadata that *does* vary lives in `run`, not `manifest`.
      expect(r1.run.capturedAt).not.toBe(r2.run.capturedAt);
      expect(r1.manifest).not.toHaveProperty("capturedAt");
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "reports a failed step with a trimmed failure report, not full HTML",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-missing-target",
        title: "Looks for something that is not there",
        start: { page: "/" },
        steps: [
          {
            id: "look-for-nothing",
            actions: [{ do: "expect", target: { text: "This text does not exist anywhere on the page" } }],
          },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      expect(result.validation.ok).toBe(false);
      expect(result.validation.steps[0].ok).toBe(false);
      expect(result.failure).toBeDefined();
      expect(result.failure?.step).toBe("look-for-nothing");
      expect(result.failure?.action).toBe("expect");
      expect(result.failure?.error.split("\n")).toHaveLength(1);
      expect(result.failure?.url).toBe(`${server.url}/`);
      expect(result.failure?.snapshot.split("\n").length).toBeLessThanOrEqual(61);
      // never the full page HTML
      expect(result.failure?.snapshot).not.toContain("<html");
      expect(result.failure?.snapshot).not.toContain("<!doctype");
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "persists the trimmed failure report to failure.json in the capture dir, and clears it once the step passes",
    async () => {
      const failingWalkthrough: Walkthrough = {
        walkthrough: "fixture-missing-target",
        title: "Looks for something that is not there",
        start: { page: "/" },
        steps: [
          {
            id: "look-for-nothing",
            actions: [{ do: "expect", target: { text: "This text does not exist anywhere on the page" } }],
          },
        ],
      };
      const outDir = tmpOutDir();
      const failurePath = join(outDir, "failure.json");

      await runCapture({ walkthrough: failingWalkthrough, config: baseConfig(server.url), outDir });
      expect(existsSync(failurePath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(failurePath, "utf8"));
      expect(onDisk.step).toBe("look-for-nothing");
      expect(onDisk.action).toBe("expect");

      const passingWalkthrough: Walkthrough = {
        walkthrough: "fixture-missing-target",
        title: "Looks for something that is there",
        start: { page: "/" },
        steps: [{ id: "look-for-something", actions: [{ do: "expect", target: { role: "heading" } }] }],
      };
      await runCapture({ walkthrough: passingWalkthrough, config: baseConfig(server.url), outDir });
      expect(existsSync(failurePath)).toBe(false);
    },
    CAPTURE_TEST_TIMEOUT,
  );
});
