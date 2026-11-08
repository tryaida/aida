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

// Device capture drives real Chromium (isMobile/hasTouch contexts included): same generous
// per-test timeout as capture.test.ts, for the same reason (contended machines).
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
  const dir = mkdtempSync(join(tmpdir(), "aida-device-capture-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("device-only steps (M43a, decision 40)", () => {
  function responsiveMenuWalkthrough(): Walkthrough {
    return {
      walkthrough: "fixture-responsive-menu",
      title: "Open reports from the menu",
      devices: ["desktop", "phone"],
      start: { page: "/responsive-menu.html" },
      steps: [
        {
          id: "open-menu",
          devices: ["phone"],
          actions: [{ do: "click", target: { role: "button", name: "Open menu" } }],
        },
        {
          id: "open-reports",
          actions: [
            { do: "click", target: { role: "link", name: "Reports" } },
            { do: "expect", target: { role: "heading", name: "Success" } },
          ],
        },
      ],
    };
  }

  it(
    "desktop capture skips the phone-only step (the sidebar link is already visible)",
    async () => {
      const result = await runCapture({ walkthrough: responsiveMenuWalkthrough(), config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
      expect(result.manifest.device).toBe("desktop");
      expect(result.manifest.steps.map((s) => s.id)).toEqual(["open-reports"]);
      expect(result.manifest.steps[0].stepIndex).toBe(1);
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "phone capture taps the menu open, then taps the revealed link",
    async () => {
      const result = await runCapture({ walkthrough: responsiveMenuWalkthrough(), config: baseConfig(server.url), outDir: tmpOutDir(), device: "phone" });
      expect(result.validation.ok).toBe(true);
      expect(result.manifest.device).toBe("phone");
      expect(result.manifest.steps.map((s) => s.id)).toEqual(["open-menu", "open-reports"]);
      expect(result.manifest.steps.map((s) => s.stepIndex)).toEqual([0, 1]);
      expect(result.manifest.finalUrl).toBe(`${server.url}/success.html`);
    },
    CAPTURE_TEST_TIMEOUT,
  );
});

describe("phone browser context (decision 40)", () => {
  it(
    "skips a setup step marked for another device: a desktop-only setup click never runs on a phone",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-touch-setup",
        title: "Touch setup",
        start: { page: "/touch-detect.html" },
        // Would time out on any device: nothing on the page is called this.
        setup: { steps: [{ id: "desktop-grid", devices: ["desktop"], actions: [{ do: "click", target: { role: "button", name: "No such button" } }] }] },
        steps: [{ id: "check", actions: [{ do: "expect", target: { text: "touch=true coarse=true" } }] }],
      };
      const phone = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir(), device: "phone" });
      expect(phone.validation.ok).toBe(true);
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "isMobile/hasTouch are really set on phone, and not on desktop",
    async () => {
      const wt = (): Walkthrough => ({
        walkthrough: "fixture-touch-detect",
        title: "Touch detect",
        start: { page: "/touch-detect.html" },
        steps: [{ id: "check", actions: [{ do: "expect", target: { text: "touch=false coarse=false" } }] }],
      });
      const desktop = await runCapture({ walkthrough: wt(), config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(desktop.validation.ok).toBe(true);

      const phoneWt: Walkthrough = { ...wt(), steps: [{ id: "check", actions: [{ do: "expect", target: { text: "touch=true coarse=true" } }] }] };
      const phone = await runCapture({ walkthrough: phoneWt, config: baseConfig(server.url), outDir: tmpOutDir(), device: "phone" });
      expect(phone.validation.ok).toBe(true);
      expect(phone.manifest.viewport).not.toEqual(desktop.manifest.viewport);
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "a custom config.phone profile is used instead of the built-in default",
    async () => {
      const config = { ...baseConfig(server.url), phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, userAgent: "custom-phone-ua" } };
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-touch-detect",
        title: "Touch detect",
        start: { page: "/touch-detect.html" },
        steps: [{ id: "check", actions: [{ do: "expect", target: { text: "touch=true coarse=true" } }] }],
      };
      const result = await runCapture({ walkthrough, config, outDir: tmpOutDir(), device: "phone" });
      expect(result.validation.ok).toBe(true);
      expect(result.manifest.viewport).toEqual({ width: 390, height: 844 });
      expect(result.manifest.deviceScaleFactor).toBe(3);
    },
    CAPTURE_TEST_TIMEOUT,
  );
});

describe("hover on a touch device (decision 40)", () => {
  it(
    "fails with a clear, fixable message instead of silently doing nothing",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys-hover",
        title: "Hover to reveal the menu",
        start: { page: "/keys-hover.html" },
        steps: [{ id: "hover-actions", actions: [{ do: "hover", target: { role: "button", name: "Actions" } }] }],
      };
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir(), device: "phone" });
      expect(result.validation.ok).toBe(false);
      expect(result.validation.steps[0].ok).toBe(false);
      expect(result.validation.steps[0].error).toMatch(/touch device/i);
      expect(result.validation.steps[0].error).toMatch(/devices: \[desktop\]/);
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "the same hover works fine on desktop",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys-hover",
        title: "Hover to reveal the menu",
        start: { page: "/keys-hover.html" },
        steps: [
          { id: "hover-actions", actions: [{ do: "hover", target: { role: "button", name: "Actions" } }] },
          { id: "see-menu", actions: [{ do: "expect", target: { role: "menuitem", name: "Open" } }] },
        ],
      };
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
    },
    CAPTURE_TEST_TIMEOUT,
  );
});
