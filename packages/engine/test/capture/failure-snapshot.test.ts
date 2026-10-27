import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "aida-failure-snapshot-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe("failure.json snapshot: prefers the real content over a long nav", () => {
  it(
    "keeps the main-landmark form in the snapshot instead of spending the line cap on a long left nav (bug: fixed line cap over `body` dropped the form)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-nav-main",
        title: "Add a competitor",
        start: { page: "/nav-main.html" },
        steps: [
          {
            id: "look-for-nothing",
            actions: [{ do: "expect", target: { text: "This text does not exist anywhere on the page" } }],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir });

      expect(result.validation.ok).toBe(false);
      expect(result.failure).toBeDefined();
      const snapshot = result.failure!.snapshot;
      // the form inside <main> made it into the trimmed snapshot
      expect(snapshot).toContain("Save competitor");
      expect(snapshot).toContain("First name");
      // the long nav's items did not — they're not what the step was about
      expect(snapshot).not.toContain("Volunteers");
      expect(snapshot).not.toContain("Catalogues");
      expect(snapshot.split("\n").length).toBeLessThanOrEqual(61);

      const onDisk = JSON.parse(readFileSync(join(outDir, "failure.json"), "utf8"));
      expect(onDisk.snapshot).toContain("Save competitor");
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back to the nearest landmark/dialog around the focused element when there is no <main> (and folds in an open dialog)",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-nav-dialog",
        title: "Add a competitor via a dialog, no main landmark",
        start: { page: "/nav-dialog.html" },
        steps: [
          {
            id: "focus-then-fail",
            actions: [
              { do: "click", target: { label: "First name" } },
              { do: "expect", target: { text: "This text does not exist anywhere on the page" } },
            ],
          },
        ],
      };

      const outDir = tmpOutDir();
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir });

      expect(result.validation.ok).toBe(false);
      expect(result.failure).toBeDefined();
      const snapshot = result.failure!.snapshot;
      expect(snapshot).toContain("Save competitor");
      expect(snapshot).toContain("First name");
      expect(snapshot).not.toContain("Volunteers");
      // the dialog content isn't duplicated just because it's both the chosen landmark AND "the
      // open dialog to always fold in"
      expect(snapshot.match(/Save competitor/g)?.length).toBe(1);
      expect(snapshot.split("\n").length).toBeLessThanOrEqual(61);
    },
    TEST_TIMEOUT,
  );

  it(
    "still never includes full HTML, on either fixture",
    async () => {
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-nav-main-html-check",
        title: "Add a competitor",
        start: { page: "/nav-main.html" },
        steps: [
          { id: "look-for-nothing", actions: [{ do: "expect", target: { text: "Nope, not here" } }] },
        ],
      };
      const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
      expect(result.failure?.snapshot).not.toContain("<html");
      expect(result.failure?.snapshot).not.toContain("<!doctype");
    },
    TEST_TIMEOUT,
  );
});

describe(
  "failure.json redaction (bug: page.url() with query tokens and unredacted textbox/table text went " +
    "straight into failure.json)",
  () => {
    it(
      "strips the query string and hash off the failing page's URL",
      async () => {
        const walkthrough: Walkthrough = {
          walkthrough: "fixture-redact-url",
          title: "t",
          start: { page: "/nav-main.html?token=super-secret-session-token#frag" },
          steps: [{ id: "fail", actions: [{ do: "expect", target: { text: "Nope, not here" } }] }],
        };

        const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

        expect(result.failure).toBeDefined();
        expect(result.failure!.url).not.toContain("token");
        expect(result.failure!.url).not.toContain("#");
        expect(result.failure!.url).not.toContain("?");
      },
      TEST_TIMEOUT,
    );

    it(
      "redacts a real email/phone in a textbox value and a secret-shaped string in page text, leaves an " +
        "example.com email untouched",
      async () => {
        const walkthrough: Walkthrough = {
          walkthrough: "fixture-redact-snapshot",
          title: "t",
          start: { page: "/failure-redact.html" },
          steps: [{ id: "fail", actions: [{ do: "expect", target: { text: "Nope, not here" } }] }],
        };

        const outDir = tmpOutDir();
        const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir });

        expect(result.failure).toBeDefined();
        const snapshot = result.failure!.snapshot;
        expect(snapshot).not.toContain("sophie.harrington@gmail.com");
        expect(snapshot).not.toContain("0412 345 678");
        expect(snapshot).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
        expect(snapshot).toContain("[REDACTED EMAIL]");
        expect(snapshot).toContain("[REDACTED PHONE]");
        expect(snapshot).toContain("[REDACTED SECRET]");
        // the safe fake-data domain stays visible, same convention the QA pass uses
        expect(snapshot).toContain("demo@example.com");

        const onDisk = JSON.parse(readFileSync(join(outDir, "failure.json"), "utf8"));
        expect(onDisk.snapshot).not.toContain("sophie.harrington@gmail.com");
        expect(JSON.stringify(onDisk)).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
      },
      TEST_TIMEOUT,
    );

    it(
      "leaves a UUID alone instead of flattening a chunk of it to [REDACTED PHONE] (bug: hid the " +
        "very id a failure needed to debug)",
      async () => {
        const walkthrough: Walkthrough = {
          walkthrough: "fixture-redact-uuid",
          title: "t",
          start: { page: "/failure-redact.html" },
          steps: [{ id: "fail", actions: [{ do: "expect", target: { text: "Nope, not here" } }] }],
        };

        const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });

        expect(result.failure).toBeDefined();
        const snapshot = result.failure!.snapshot;
        expect(snapshot).toContain("0491c2a4-5701-4e12-9f34-abc123456789");
        // the genuine phone number elsewhere on the page is still redacted — this isn't a
        // blanket opt-out of phone redaction, just a guard for id/hash-shaped text
        expect(snapshot).not.toContain("0412 345 678");
        expect(snapshot).toContain("[REDACTED PHONE]");
      },
      TEST_TIMEOUT,
    );
  },
);
