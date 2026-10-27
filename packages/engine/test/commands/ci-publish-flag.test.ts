// `aida ci`'s exit-code gating (build-plan.md M19; docs/scope.md "Three kinds of change"):
// a broken walkthrough only fails the check when the repo owner opts in via
// `config.ci.failOnBroken` (default false). Mocks `runCi` and `loadConfig` so this is a fast
// unit test of the gating logic in commands/ci.ts, not an end-to-end capture run.
import { describe, expect, it, vi } from "vitest";
import type { CiResult } from "../../src/ci/types.js";
import type { ResolvedConfig } from "../../src/config/types.js";

function brokenResult(): CiResult {
  return {
    base: "base",
    head: "head",
    affected: ["broken-one"],
    all: false,
    results: [
      {
        walkthrough: "broken-one",
        status: "failed",
        tier: "broken",
        changedSteps: [],
        failure: { summary: "boom", repairCommand: "claude -p ..." },
      },
    ],
    newRoutes: [],
    stalePages: [],
    outDir: "/tmp/out",
  };
}

function fakeConfig(ci?: ResolvedConfig["ci"]): ResolvedConfig {
  return {
    app: { baseUrl: "http://localhost:3000" },
    configDir: "/tmp",
    walkthroughsDir: "/tmp/walkthroughs",
    outDir: "/tmp/help",
    buildDir: "/tmp/.build",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    ci,
  };
}

// Each test re-imports commands/ci.ts fresh (vi.resetModules) — a cold import of its whole module
// graph, which can pass 5 s on a busy machine.
describe("runCiCommand — failOnBroken gating", { timeout: 30_000 }, () => {
  it("is ok even with a broken walkthrough when ci.failOnBroken is unset (default false)", async () => {
    vi.resetModules();
    vi.doMock("../../src/ci/run.js", () => ({ runCi: vi.fn(async () => brokenResult()) }));
    vi.doMock("../../src/config/index.js", () => ({ loadConfig: vi.fn(async () => fakeConfig()) }));
    const { runCiCommand } = await import("../../src/commands/ci.js");

    const result = await runCiCommand({ configPath: "aida.config.ts", base: "base" });
    expect(result.ok).toBe(true);
    expect(result.ci.results[0].tier).toBe("broken");
    vi.doUnmock("../../src/ci/run.js");
    vi.doUnmock("../../src/config/index.js");
  });

  it("fails when ci.failOnBroken is true and a walkthrough broke", async () => {
    vi.resetModules();
    vi.doMock("../../src/ci/run.js", () => ({ runCi: vi.fn(async () => brokenResult()) }));
    vi.doMock("../../src/config/index.js", () => ({ loadConfig: vi.fn(async () => fakeConfig({ failOnBroken: true })) }));
    const { runCiCommand } = await import("../../src/commands/ci.js");

    const result = await runCiCommand({ configPath: "aida.config.ts", base: "base" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/broke/);
    vi.doUnmock("../../src/ci/run.js");
    vi.doUnmock("../../src/config/index.js");
  });
});
