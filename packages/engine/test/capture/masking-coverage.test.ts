import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __createdTmpDirs: string[] = [];

vi.mock("../../src/capture/mask.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/capture/mask.js")>();
  return {
    ...mod,
    applyMasks: vi.fn(mod.applyMasks),
    clearMasks: vi.fn(mod.clearMasks),
  };
});

// Imported *after* the mock so `runner.ts` picks up the spied functions.
const { runCapture } = await import("../../src/capture/runner.js");
const { applyMasks } = await import("../../src/capture/mask.js");

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
  vi.mocked(applyMasks).mockClear();
});

afterEach(async () => {
  await server.close();
  while (__createdTmpDirs.length) rmSync(__createdTmpDirs.pop()!, { recursive: true, force: true });
});

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
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-mask-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("runCapture masking (bug: first frame / failure frame / scroll frames were shot unmasked)", () => {
  it(
    "masks the very first frame of the run using the first step's mask",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-first-frame-mask",
        title: "t",
        start: { page: "/" },
        steps: [
          {
            id: "only-step",
            mask: ["Email"],
            actions: [{ do: "expect", target: { text: "Capture fixture" } }],
          },
        ],
      };

      await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      // First call to applyMasks is the pre-loop "state" frame; it must already
      // carry the first step's mask, not `undefined`.
      expect(vi.mocked(applyMasks).mock.calls[0][1]).toEqual(["Email"]);
    },
    20_000,
  );

  it(
    "masks the failure screenshot with the failing step's mask",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-failure-mask",
        title: "t",
        start: { page: "/" },
        steps: [
          {
            id: "fails",
            mask: ["Email"],
            actions: [{ do: "expect", target: { text: "this text does not exist anywhere" } }],
          },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(false);

      const calls = vi.mocked(applyMasks).mock.calls;
      const failureCall = calls.find((c) => c[1]?.includes("Email"));
      expect(failureCall).toBeDefined();
    },
    25_000,
  );

  it(
    "masks every frame of a scroll burst (settle.ts smoothScrollTo), not just the still frames",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-scroll-mask",
        title: "t",
        start: { page: "/tall.html" },
        steps: [
          {
            id: "scroll",
            mask: ["Email"],
            actions: [{ do: "scrollTo", target: { role: "button", name: "Add thing" } }],
          },
        ],
      };

      await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      const maskedCallCount = vi.mocked(applyMasks).mock.calls.filter((c) => c[1]?.includes("Email")).length;
      // At least the pre-loop frame plus one scroll-burst frame were masked.
      expect(maskedCallCount).toBeGreaterThan(1);
    },
    20_000,
  );
});
