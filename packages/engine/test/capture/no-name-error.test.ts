// Regression test for the "ReferenceError: __name is not defined" bug: tsx's dev transform can
// wrap a named function nested inside another function with a call to a `__name(...)` helper that
// doesn't exist in the browser realm an addInitScript callback runs in (see
// src/capture/init-scripts.ts for the full story). That threw a `pageerror` on every navigation,
// failing `validation.ok` on every real-app capture even though every step itself succeeded. This
// test runs under vitest (i.e. under tsx, the exact toolchain that triggered it) and asserts no
// page errors ever reach the manifest/validation output.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __createdTmpDirs: string[] = [];

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
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
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-no-name-error-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("runCapture (bug: ReferenceError: __name is not defined on every page under tsx)", () => {
  it(
    "reports no page errors across a multi-navigation walkthrough",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-no-name-error",
        title: "t",
        start: { page: "/" },
        steps: [
          {
            id: "see-fixture",
            actions: [{ do: "expect", target: { role: "heading", name: "Capture fixture" } }],
          },
          {
            id: "navigate",
            actions: [
              { do: "click", target: { role: "link", name: "Go to success" } },
              { do: "waitForUrl", pattern: "/success\\.html" },
            ],
          },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      expect(result.validation.problems.page).toEqual([]);
      expect(result.validation.problems.page.some((p) => p.text?.includes("__name"))).toBe(false);
      expect(result.validation.ok).toBe(true);
    },
    30_000,
  );
});
