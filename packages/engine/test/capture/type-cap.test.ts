// `config.capture.maxTypeMs` (default 1500ms): caps the wall-clock time a `type` action spends
// doing visible, per-character typing (one screenshot per char, for the video) before filling
// the rest in one shot — see capture/runner.ts's "type" case. docs/build-plan.md: "6 steps took
// 255s, typing UUIDs" was the motivating real-world cost.
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

const TEST_TIMEOUT = 60_000;

beforeEach(async () => {
  server = await startFixtureServer();
}, TEST_TIMEOUT);

afterEach(async () => {
  await server.close();
  while (__createdTmpDirs.length) rmSync(__createdTmpDirs.pop()!, { recursive: true, force: true });
}, TEST_TIMEOUT);

function baseConfig(baseUrl: string, maxTypeMs?: number): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    // `maxTypeMs` isn't on `CaptureSettings` yet (src/config/**, owned elsewhere this round) —
    // cast past the excess-property check the same way runner.ts reads it loosely.
    ...(maxTypeMs !== undefined ? { capture: { maxTypeMs } as ResolvedConfig["capture"] } : {}),
  };
}

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-type-cap-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

function longTextWalkthrough(text: string): Walkthrough {
  return {
    walkthrough: "fixture-type-cap",
    title: "t",
    start: { page: "/" },
    steps: [
      {
        id: "enter-name",
        actions: [
          { do: "click", target: { label: "First name" } },
          { do: "type", target: { label: "First name" }, text },
        ],
      },
    ],
  };
}

describe("type action: capture.maxTypeMs caps visible per-character typing", () => {
  it(
    "types fewer than one frame per character once the cap is hit, but still ends with the full value",
    async () => {
      const longValue = "0491c2a4-5701-4e12-9f34-abc123456789"; // UUID-shaped, the motivating case
      const walkthrough = longTextWalkthrough(longValue);

      const result = await runCapture({
        walkthrough,
        config: baseConfig(server.url, 50),
        outDir: tmpOutDir(),
      });

      expect(result.validation.ok).toBe(true);
      const typeCheck = result.manifest.steps[0].checks.find((c) => "type" in c) as
        | { value?: string | null }
        | undefined;
      // the final input value is still correct, even though most characters were filled instead
      // of individually typed
      expect(typeCheck?.value).toBe(longValue);

      const typeFramesEvent = result.manifest.steps[0].events.find((e) => e.type === "typeFrames") as
        | { images: string[]; text: string }
        | undefined;
      expect(typeFramesEvent).toBeDefined();
      expect(typeFramesEvent!.text).toBe(longValue);
      // capped well short of one frame per character (37 chars) — the cap actually did something
      expect(typeFramesEvent!.images.length).toBeLessThan(longValue.length);
    },
    TEST_TIMEOUT,
  );

  it(
    "never caps a short value typed well within the budget (frames unaffected otherwise)",
    async () => {
      const shortValue = "Ada";
      const walkthrough = longTextWalkthrough(shortValue);

      const result = await runCapture({
        walkthrough,
        config: baseConfig(server.url, 1500),
        outDir: tmpOutDir(),
      });

      expect(result.validation.ok).toBe(true);
      const typeFramesEvent = result.manifest.steps[0].events.find((e) => e.type === "typeFrames") as
        | { images: string[]; text: string }
        | undefined;
      expect(typeFramesEvent!.images.length).toBe(shortValue.length);
    },
    TEST_TIMEOUT,
  );
});
