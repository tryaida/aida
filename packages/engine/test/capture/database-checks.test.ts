import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../../src/config/types.js";
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

function baseConfig(baseUrl: string, database?: DatabaseAdapter): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    database,
  };
}

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-db-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

function walkthroughWithDbCheck(expect_: Record<string, unknown>): Walkthrough {
  return {
    walkthrough: "fixture-db-check",
    title: "t",
    start: { page: "/" },
    steps: [{ id: "noop", actions: [{ do: "expect", target: { text: "Capture fixture" } }] }],
    validate: {
      database: [{ name: "row matches", sql: "select 1 as n", expect: expect_ }],
    },
  };
}

describe("runCapture database checks", () => {
  it(
    "fails fast on a non-local database URL, before the walkthrough even replays (bug: assertLocalDatabase ran after replay, outside try)",
    async () => {
      const calls: string[] = [];
      const database: DatabaseAdapter = {
        url: () => "postgresql://prod-db.example.com:5432/app",
        query: async () => {
          calls.push("query");
          return [{ n: 1 }];
        },
        close: async () => {
          calls.push("close");
        },
      };

      await expect(
        runCapture({ walkthrough: walkthroughWithDbCheck({ n: 1 }), config: baseConfig(server.url, database), outDir: tmpOutDir() }),
      ).rejects.toThrow(/refusing/i);

      // Replay (and therefore any query) must never have been attempted.
      expect(calls).not.toContain("query");
    },
    20_000,
  );

  it(
    "calls database.url() exactly once and reuses it for both the query and the redacted validation.database field (bug: url() called again after close())",
    async () => {
      const urlFn = vi.fn(() => `postgresql://127.0.0.1:55432/app?sslmode=require`);
      const queryCtxUrls: (string | undefined)[] = [];
      const database: DatabaseAdapter = {
        url: urlFn,
        query: async (_sql, _params, ctx) => {
          queryCtxUrls.push(ctx?.url);
          return [{ n: 1 }];
        },
        close: async () => {},
      };

      const result = await runCapture({
        walkthrough: walkthroughWithDbCheck({ n: 1 }),
        config: baseConfig(server.url, database),
        outDir: tmpOutDir(),
      });

      expect(urlFn).toHaveBeenCalledTimes(1);
      // The exact checked URL was handed to query() (bug: TOCTOU — adapter re-derived its own URL).
      expect(queryCtxUrls).toEqual(["postgresql://127.0.0.1:55432/app?sslmode=require"]);
      // Credentials *and* the query string are stripped from the redacted URL (bug: query string leaked).
      expect(result.validation.database).toBe("postgresql://127.0.0.1:55432/app");
      expect(result.validation.database).not.toContain("sslmode");
    },
    20_000,
  );

  it(
    "closes the database connection even when a check throws (bug: close() wasn't in a finally)",
    async () => {
      const closed = vi.fn();
      const database: DatabaseAdapter = {
        url: () => "postgresql://127.0.0.1:55432/app",
        query: async () => {
          throw new Error("boom");
        },
        close: closed,
      };

      const result = await runCapture({
        walkthrough: walkthroughWithDbCheck({ n: 1 }),
        config: baseConfig(server.url, database),
        outDir: tmpOutDir(),
      });

      expect(result.validation.dbChecks[0].ok).toBe(false);
      expect(closed).toHaveBeenCalledTimes(1);
    },
    20_000,
  );

  it(
    "normalises values before comparing expect vs. row (bug: strict === failed number-vs-string / object-vs-object)",
    async () => {
      const database: DatabaseAdapter = {
        url: () => "postgresql://127.0.0.1:55432/app",
        // Postgres driver returns a numeric count as a JS number; walkthrough YAML params are strings.
        query: async () => [{ n: 3, tags: ["a", "b"] }],
        close: async () => {},
      };

      const result = await runCapture({
        walkthrough: walkthroughWithDbCheck({ n: "3", tags: ["a", "b"] }),
        config: baseConfig(server.url, database),
        outDir: tmpOutDir(),
      });

      expect(result.validation.dbChecks[0].ok).toBe(true);
    },
    20_000,
  );

  it(
    "never calls database.url()/reset or sets validation.database when the walkthrough has no validate.database (bug: url() called unconditionally)",
    async () => {
      const urlFn = vi.fn(() => "postgresql://127.0.0.1:55432/app");
      const database: DatabaseAdapter = {
        url: urlFn,
        query: async () => [],
        close: async () => {},
      };
      const walkthrough: Walkthrough = {
        walkthrough: "fixture-no-db-check",
        title: "t",
        start: { page: "/" },
        steps: [{ id: "noop", actions: [{ do: "expect", target: { text: "Capture fixture" } }] }],
      };

      const result = await runCapture({ walkthrough, config: baseConfig(server.url, database), outDir: tmpOutDir() });

      expect(urlFn).not.toHaveBeenCalled();
      expect(result.validation.database).toBeUndefined();
    },
    20_000,
  );
});
