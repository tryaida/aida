import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const config: ResolvedConfig = {
  app: { baseUrl: "http://localhost:9" },
  configDir: tmpdir(),
  walkthroughsDir: tmpdir(),
  outDir: tmpdir(),
  buildDir: tmpdir(),
};

const walkthrough: Walkthrough = {
  walkthrough: "menu",
  title: "t",
  devices: ["desktop", "phone"],
  steps: [
    { id: "open-menu", devices: ["phone"], actions: [{ do: "expect", target: { text: "Menu" } }] },
    { id: "see-list", actions: [{ do: "expect", target: { text: "List" } }] },
  ],
};

describe("runCapture stopAfterStep on a device-only step", () => {
  it("refuses a step this device skips before any browser opens (it would never stop)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "aida-stop-device-"));
    dirs.push(outDir);
    await expect(runCapture({ walkthrough, config, outDir, device: "desktop", stopAfterStep: "open-menu" })).rejects.toThrow(
      /step "open-menu" doesn't run on desktop \(devices: phone\)/,
    );
  });
});
