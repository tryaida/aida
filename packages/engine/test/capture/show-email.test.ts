// `showEmail`: an emulated email drawn over the app, and one the app sent, caught locally.
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { ActionSchema } from "../../src/walkthrough/action.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
let server: FixtureServer;
const dirs: string[] = [];

beforeEach(async () => {
  server = await startFixtureServer();
}, TIMEOUT);
afterEach(async () => {
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function outDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aida-show-email-"));
  dirs.push(d);
  return d;
}

function config(extra: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { app: { baseUrl: server.url }, configDir: tmpdir(), walkthroughsDir: tmpdir(), outDir: tmpdir(), buildDir: tmpdir(), viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, ...extra };
}

describe("showEmail", () => {
  it("validates: mock or to/subject, not both, not neither", () => {
    expect(ActionSchema.safeParse({ do: "showEmail", subject: "Welcome" }).success).toBe(true);
    expect(ActionSchema.safeParse({ do: "showEmail", mock: { from: "a", to: "b", subject: "c", text: "d" } }).success).toBe(true);
    expect(ActionSchema.safeParse({ do: "showEmail" }).success).toBe(false);
    expect(ActionSchema.safeParse({ do: "showEmail", subject: "x", mock: { from: "a", to: "b", subject: "c", text: "d" } }).success).toBe(false);
    expect(ActionSchema.safeParse({ do: "showEmail", mock: { from: "a", to: "b", subject: "c" } }).success).toBe(false);
  });

  it(
    "draws a mock email over the app, then takes it away for the next action",
    async () => {
      const wt: Walkthrough = {
        walkthrough: "mock-email",
        title: "t",
        start: { page: "/" },
        steps: [
          { id: "inbox", actions: [{ do: "showEmail", highlight: true, mock: { from: "Acme <no-reply@example.com>", to: "sam@example.com", subject: "Welcome to Acme", text: "Hello Sam" } }] },
          { id: "back", actions: [{ do: "expect", target: { label: "First name" } }] },
        ],
      };
      const result = await runCapture({ walkthrough: wt, config: config(), outDir: outDir() });
      expect(result.failure).toBeUndefined();
      expect(result.validation.ok).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "shows an email the app sent to the catcher, and says plainly when there's no catcher",
    async () => {
      const wt: Walkthrough = {
        walkthrough: "caught-email",
        title: "t",
        start: { page: "/" },
        steps: [{ id: "inbox", actions: [{ do: "showEmail", to: "sam@example.com", subject: "Welcome" }] }],
      };
      const noCatcher = await runCapture({ walkthrough: wt, config: config(), outDir: outDir() });
      expect(noCatcher.failure?.error).toMatch(/no mail catcher/);

      // The "app": sends a message to the catcher a moment after capture starts.
      const port = 20000 + Math.floor(Math.random() * 20000);
      const sendSoon = setTimeout(() => {
        const s = createConnection(port, "127.0.0.1");
        const lines = ["EHLO app", "MAIL FROM:<a@example.com>", "RCPT TO:<sam@example.com>", "DATA", "Subject: Welcome aboard\r\n\r\nHi Sam\r\n.", "QUIT"];
        let i = 0;
        s.on("data", () => {
          if (i < lines.length) s.write(`${lines[i++]}\r\n`);
        });
        s.on("error", () => {});
      }, 1500);
      try {
        const caught = await runCapture({ walkthrough: wt, config: config({ mail: { port } }), outDir: outDir() });
        expect(caught.failure).toBeUndefined();
        expect(caught.validation.ok).toBe(true);
      } finally {
        clearTimeout(sendSoon);
      }
    },
    TIMEOUT,
  );
});
