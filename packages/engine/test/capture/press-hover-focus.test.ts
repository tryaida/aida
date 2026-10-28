// M38: `press`, `hover`, `focus` and exact-text checks run against a real page.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { parseDoString } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TEST_TIMEOUT = 60_000;
const dirs: string[] = [];
let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
}, TEST_TIMEOUT);

afterEach(async () => {
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}, TEST_TIMEOUT);

function config(baseUrl: string): ResolvedConfig {
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

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-keys-test-"));
  dirs.push(dir);
  return dir;
}

describe("press, hover, focus and text checks in capture", () => {
  it(
    "focuses a field, presses Enter in another, checks exact text, hovers a menu open and presses shortcuts",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys",
        title: "Find an order",
        start: { page: "/keys-hover.html" },
        steps: [
          { id: "focus-email", actions: [...parseDoString('focus "Email"'), { do: "expect", target: { css: "#focus-note" }, text: "Email has focus", exact: true }] },
          {
            id: "search",
            actions: [
              { do: "type", target: { label: "Search" }, text: "ORD-1001" },
              ...parseDoString('press "Enter" in "Search"'),
              // Whitespace in the page's text is collapsed before comparing, as toHaveText does.
              { do: "expect", target: { role: "status" }, text: "1 order found", exact: true },
              { do: "expect", target: { role: "status" }, text: "order" },
            ],
          },
          { id: "hover-actions", actions: [...parseDoString('hover "Actions" button'), { do: "expect", target: { role: "menuitem", name: "Open" } }] },
          {
            id: "palette",
            actions: [{ do: "press", key: "Control+k" }, { do: "expect", target: { role: "dialog", name: "Command palette" } }, ...parseDoString('press "Escape"')],
          },
        ],
      };

      const result = await runCapture({ walkthrough, config: config(server.url), outDir: outDir() });
      expect(result.validation.steps.map((s) => [s.id, s.ok, s.error])).toEqual([
        ["focus-email", true, undefined],
        ["search", true, undefined],
        ["hover-actions", true, undefined],
        ["palette", true, undefined],
      ]);
      expect(result.validation.ok).toBe(true);

      const steps = new Map(result.manifest.steps.map((s) => [s.id, s]));
      // Hover moves the pointer onto the element, and never clicks it.
      const hover = steps.get("hover-actions")!;
      expect(hover.events.some((e) => e.type === "move")).toBe(true);
      expect(hover.events.some((e) => e.type === "click")).toBe(false);
      // A key press is the keyboard: no pointer move or click, but the result is shown.
      const palette = steps.get("palette")!;
      expect(palette.events.some((e) => e.type === "move" || e.type === "click")).toBe(false);
      expect(palette.events.some((e) => e.type === "frame")).toBe(true);
      expect(steps.get("search")!.checks).toContainEqual({ press: "Enter", target: { label: "Search" }, ok: true });
      expect(steps.get("search")!.checks).toContainEqual({ expect: { role: "status" }, text: "1 order found", exact: true, shown: "1 order found", ok: true });
    },
    TEST_TIMEOUT,
  );

  it(
    "compares the element's textContent, as Playwright's text matchers do: CSS case ignored, hidden text kept (M38 review)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys-text-content",
        title: "Read a label",
        start: { page: "/keys-hover.html" },
        steps: [{ id: "read", actions: [{ do: "expect", target: { css: "#shout" }, text: "Saved as draft", exact: true }] }],
      };
      const result = await runCapture({ walkthrough, config: config(server.url), outDir: outDir(), maxWaitMs: 1_500 });
      expect(result.validation.steps[0].error).toBeUndefined();
      expect(result.validation.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails a press whose target can't take focus, rather than sending the key to the page (M38 review)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys-unfocusable",
        title: "Press on a heading",
        start: { page: "/keys-hover.html" },
        steps: [{ id: "press", actions: [{ do: "press", key: "Enter", target: { role: "heading", name: "Orders" } }] }],
      };
      const result = await runCapture({ walkthrough, config: config(server.url), outDir: outDir(), maxWaitMs: 1_500 });
      expect(result.validation.ok).toBe(false);
      expect(result.validation.steps[0].error).toMatch(/did not take keyboard focus, so Enter would go to the page/);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails an exact text check when the element shows more than the text, saying what it shows",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-keys-exact",
        title: "Find an order",
        start: { page: "/keys-hover.html" },
        steps: [
          {
            id: "search",
            actions: [
              { do: "type", target: { label: "Search" }, text: "ORD-1001" },
              { do: "press", key: "Enter" },
              { do: "expect", target: { role: "status" }, text: "1 order", exact: true },
            ],
          },
        ],
      };
      const result = await runCapture({ walkthrough, config: config(server.url), outDir: outDir(), maxWaitMs: 1_500 });
      expect(result.validation.ok).toBe(false);
      expect(result.validation.steps[0].error).toMatch(/to be exactly "1 order" but it shows "1 order found"/);
    },
    TEST_TIMEOUT,
  );
});
