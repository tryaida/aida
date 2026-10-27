import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { parseDoString } from "../../src/walkthrough/index.js";
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
  const dir = mkdtempSync(join(tmpdir(), "aida-select-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("select action", () => {
  it(
    "drives a native <select> with selectOption, by option label (bug: locator.click() on role=option times out on a native select)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-native-select",
        title: "Pick a customer",
        start: { page: "/select-native.html" },
        steps: [
          {
            id: "pick-customer",
            actions: [{ do: "select", target: { label: "Customer" }, option: "Acme" }],
          },
          { id: "confirm", actions: [{ do: "expect", target: { text: "Selected: Acme" } }] },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

      expect(result.validation.ok).toBe(true);
      expect(result.validation.steps.every((s) => s.ok)).toBe(true);
      const step = result.manifest.steps.find((s) => s.id === "pick-customer");
      // a frame + highlight were recorded like other actions
      expect(step?.events.some((e) => e.type === "frame")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back to selectOption by value when the option label doesn't match",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-native-select-value",
        title: "Pick a customer by value",
        start: { page: "/select-native.html" },
        steps: [{ id: "pick-customer", actions: [{ do: "select", target: { label: "Customer" }, option: "acme" }] }],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "drives a custom combobox (no native <select>) with the open-then-click-option behaviour",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-custom-select",
        title: "Pick a customer (custom widget)",
        start: { page: "/select-custom.html" },
        steps: [
          {
            id: "pick-customer",
            actions: [{ do: "select", target: { role: "button", name: "Customer: Choose…" }, option: "Acme" }],
          },
          { id: "confirm", actions: [{ do: "expect", target: { text: "Selected: Acme" } }] },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
      expect(result.validation.steps.every((s) => s.ok)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "scopes the option click to the trigger's own listbox and verifies the selection (bug: page-wide " +
      "getByText(option) could hit a decoy elsewhere on the page and still report ok:true)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-custom-select-trap",
        title: "Pick a customer (decoy text on page)",
        start: { page: "/select-custom-trap.html" },
        steps: [
          {
            id: "pick-customer",
            actions: [{ do: "select", target: { role: "button", name: "Customer: Choose…" }, option: "Acme" }],
          },
          { id: "confirm", actions: [{ do: "expect", target: { text: "Selected: Acme" } }] },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
      expect(result.validation.steps.every((s) => s.ok)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails the step when the option click doesn't actually change the trigger (bug: the old code pushed " +
      "ok:true for the click without checking anything actually got selected)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-custom-select-broken",
        title: "Pick a customer (broken widget)",
        start: { page: "/select-custom-broken.html" },
        steps: [
          {
            id: "pick-customer",
            actions: [{ do: "select", target: { role: "button", name: "Customer: Choose…" }, option: "Acme" }],
          },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(false);
      const step = result.validation.steps.find((s) => s.id === "pick-customer");
      expect(step?.ok).toBe(false);
      expect(step?.error).toMatch(/does not appear selected/);
    },
    TEST_TIMEOUT,
  );

  it("parses plain-words 'select \"X\" option \"Y\"' into a single select action", () => {
    expect(parseDoString('select "Customer" option "Acme"')).toEqual([
      { do: "select", target: { label: "Customer" }, option: "Acme" },
    ]);
  });

  it(
    "keeps explicit click/click pairs working unchanged (no select action involved)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-explicit-clicks",
        title: "Pick a customer via explicit clicks",
        start: { page: "/select-custom.html" },
        steps: [
          {
            id: "open-and-pick",
            actions: [
              { do: "click", target: { role: "button", name: "Customer: Choose…" } },
              { do: "click", target: { text: "Acme", exact: true } },
            ],
          },
          { id: "confirm", actions: [{ do: "expect", target: { text: "Selected: Acme" } }] },
        ],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.validation.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
