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

// Matches capture.test.ts: a real browser needs real headroom under contended CI/local load.
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

// Regression for the bug seen live on a pilot app (update-a-competitors-phone, step 5): a `click` with
// `highlight: true` that navigates to another page left its click-time box in the manifest, so
// the doc screenshot (taken after the step's later actions, on the new page) drew a highlight
// over unrelated content. index.html's "Go to success" link navigates to success.html, which has
// no element at the link's old position — exactly that shape of bug.
describe("runCapture — highlight re-resolution for the doc screenshot", () => {
  it(
    "drops a click-time highlight that doesn't survive navigation, instead of drawing it on the new page",
    async () => {
      const logs: string[] = [];
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-highlight-stale",
        title: "Navigate away from a highlighted click",
        start: { page: "/" },
        steps: [
          {
            id: "go-to-success",
            actions: [
              { do: "click", target: { role: "link", name: "Go to success" }, highlight: true },
              { do: "expect", target: { role: "heading", name: "Success" } },
            ],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({
        walkthrough,
        config: baseConfig(server.url),
        outDir,
        log: (...args) => logs.push(args.map(String).join(" ")),
      });

      expect(result.validation.ok).toBe(true);
      const step = result.manifest.steps[0];
      // The doc screenshot (and the overlay pages/annotate.ts draws from it) must carry no stale
      // highlight once the click's target no longer exists on the page the screenshot is of.
      expect(step.doc.highlights).toEqual([]);
      // The click's own highlight event is still in the event stream — the video still shows the
      // box at click time, before navigation; only the doc screenshot's box was dropped.
      expect(step.events.some((e) => e.type === "highlight")).toBe(true);
      void logs; // a plain click always clears its own highlight before the result frame; see below for the warned-drop path
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "warns (without failing the capture) when a surviving highlight's target is gone by the time the doc screenshot is taken",
    async () => {
      const logs: string[] = [];
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-highlight-warn",
        title: "Highlight something, then navigate without clearing it",
        start: { page: "/" },
        steps: [
          {
            // `point` (unlike `click`) leaves its highlight active rather than clearing it, and
            // `goto` doesn't touch it either — so by the time this step's actions finish, the
            // step still thinks the link is highlighted, but the page has moved on to success.html,
            // which has no such link. Exercises the "re-resolve fails -> drop + warn" path
            // directly, distinct from the click-always-clears path above.
            id: "point-then-navigate-away",
            actions: [
              { do: "point", target: { role: "link", name: "Go to success" }, highlight: true },
              { do: "goto", path: "/success.html" },
            ],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({
        walkthrough,
        config: baseConfig(server.url),
        outDir,
        log: (...args) => logs.push(args.map(String).join(" ")),
      });

      expect(result.validation.ok).toBe(true);
      const step = result.manifest.steps[0];
      expect(step.doc.highlights).toEqual([]);
      expect(logs.some((l) => l.includes("highlight") && l.includes("dropping"))).toBe(true);
    },
    CAPTURE_TEST_TIMEOUT,
  );

  it(
    "re-resolves a highlight against the post-navigation page rather than reusing the pre-click box",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-highlight-renav",
        title: "Highlight the post-navigation target",
        start: { page: "/" },
        steps: [
          {
            id: "go-to-success",
            actions: [
              { do: "click", target: { role: "link", name: "Go to success" }, highlight: true },
              { do: "expect", target: { role: "heading", name: "Success" }, highlight: true },
            ],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir });

      expect(result.validation.ok).toBe(true);
      const step = result.manifest.steps[0];
      // Exactly one highlight makes it to the doc screenshot — the post-navigation one.
      expect(step.doc.highlights).toHaveLength(1);

      const clickTimeBox = step.events.find((e) => e.type === "highlight")?.["box" as never] as
        | { x: number; y: number; w: number; h: number }
        | undefined;
      expect(clickTimeBox).toBeDefined();
      // The doc's box describes the heading on success.html, not the link's old position on
      // index.html — it must have been re-resolved, not carried over from click time.
      expect(step.doc.highlights[0]).not.toEqual(clickTimeBox);
    },
    CAPTURE_TEST_TIMEOUT,
  );
});
