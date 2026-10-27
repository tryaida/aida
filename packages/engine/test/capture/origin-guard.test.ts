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
let offOriginServer: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
  offOriginServer = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  await offOriginServer.close();
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
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-origin-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("runCapture origin guards", () => {
  it(
    "rejects a walkthrough start.baseUrl that differs from config.app.baseUrl's origin (bug: redirect target for signIn)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-bad-start-baseurl",
        title: "t",
        // Different origin from config.app.baseUrl (offOriginServer is on a different port).
        start: { page: "/", baseUrl: offOriginServer.url },
        steps: [{ id: "noop", actions: [{ do: "expect", target: { text: "Capture fixture" } }] }],
      };

      await expect(runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() })).rejects.toThrow(
        /does not match config\.app\.baseUrl origin/,
      );
    },
    20_000,
  );

  it(
    "rejects an absolute off-origin 'goto' action instead of silently navigating away (bug: new URL(path, page.url()) accepted absolute URLs)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-cross-origin-goto",
        title: "t",
        start: { page: "/" },
        steps: [{ id: "escape", actions: [{ do: "goto", path: offOriginServer.url + "/success.html" }] }],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(false);
      expect(result.validation.steps[0].ok).toBe(false);
      expect(result.failure?.error).toMatch(/cross-origin/i);
      // The page must never have actually navigated off-origin.
      expect(result.manifest.finalUrl).toBe(`${server.url}/`);
    },
    20_000,
  );

  it(
    "allows a same-origin absolute 'goto' path",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-same-origin-goto",
        title: "t",
        start: { page: "/" },
        steps: [{ id: "ok", actions: [{ do: "goto", path: server.url + "/success.html" }] }],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
      expect(result.manifest.finalUrl).toBe(`${server.url}/success.html`);
    },
    20_000,
  );
});
