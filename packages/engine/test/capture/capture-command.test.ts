import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __createdTmpDirs: string[] = [];

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
  (globalThis as Record<string, unknown>).__dbResetCount = 0;
  (globalThis as Record<string, unknown>).__storageStateWrites = [];
});

afterEach(async () => {
  await server.close();
  while (__createdTmpDirs.length) rmSync(__createdTmpDirs.pop()!, { recursive: true, force: true });
});

function tmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-command-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, extra = ""): void {
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `
    export default {
      app: { baseUrl: ${JSON.stringify(server.url)} },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
      ${extra}
    };
    `,
  );
}

function writeWalkthrough(dir: string, name: string, extra = ""): void {
  mkdirSync(join(dir, "walkthroughs"), { recursive: true });
  writeFileSync(
    join(dir, "walkthroughs", `${name}.yaml`),
    `
walkthrough: ${name}
title: t
start:
  page: /
steps:
  - id: noop
    actions:
      - do: expect
        target:
          text: Capture fixture
${extra}
`,
  );
}

describe("runCaptureCommand database reset gating (bug: reset() ran before the local-DB check, for every walkthrough regardless of validate.database)", () => {
  it("resets only the walkthrough that declares validate.database, after checking the URL is local", async () => {
    const dir = tmpProjectDir();
    writeFileSync(
      join(dir, "database.mjs"),
      `
      export default {
        url() { return "http://127.0.0.1:1"; },
        async reset() { globalThis.__dbResetCount = (globalThis.__dbResetCount ?? 0) + 1; },
        async query() { return [{ n: 1 }]; },
        async close() {},
      };
      `,
    );
    writeConfig(dir, `database: "./database.mjs",`);
    writeWalkthrough(dir, "no-db-check");
    writeWalkthrough(
      dir,
      "with-db-check",
      `validate:
  database:
    - name: check
      sql: select 1 as n
      expect:
        n: 1
`,
    );

    await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });

    expect((globalThis as Record<string, unknown>).__dbResetCount).toBe(1);
  }, 30_000);

  it("refuses to reset (or capture) when the configured database URL is not local", async () => {
    const dir = tmpProjectDir();
    writeFileSync(
      join(dir, "database.mjs"),
      `
      export default {
        url() { return "postgresql://prod-db.example.com:5432/app"; },
        async reset() { globalThis.__dbResetCount = (globalThis.__dbResetCount ?? 0) + 1; },
        async query() { return [{ n: 1 }]; },
        async close() {},
      };
      `,
    );
    writeConfig(dir, `database: "./database.mjs",`);
    writeWalkthrough(
      dir,
      "with-db-check",
      `validate:
  database:
    - name: check
      sql: select 1 as n
      expect:
        n: 1
`,
    );

    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });

    expect(code).toBe(1);
    expect((globalThis as Record<string, unknown>).__dbResetCount).toBe(0);
  }, 30_000);
});

describe("runCaptureCommand run-level error reporting (bug: full Playwright call log stored as the error)", () => {
  it("keeps only the first line of a run-level failure", async () => {
    const dir = tmpProjectDir();
    writeFileSync(
      join(dir, "sign-in.mjs"),
      `
      export default async function signIn() {
        throw new Error("sign-in failed (HTTP 401)\\nCall log:\\n  - navigating to foo\\n  - waiting for bar");
      }
      `,
    );
    writeConfig(dir, `signIn: "./sign-in.mjs",`);
    writeWalkthrough(dir, "fails-to-sign-in");

    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });

    expect(code).toBe(1);
    const outDir = join(dir, ".build", "fails-to-sign-in", "capture");
    // No manifest/validation written for a run-level failure, but the summary's error is first-line only.
    expect(() => readFileSync(join(outDir, "manifest.json"))).toThrow();
  }, 30_000);
});

describe("runCaptureCommand storageState keying (bug: one shared storageState file for every baseUrl/persona)", () => {
  it("writes a distinct storageState file per persona", async () => {
    const dir = tmpProjectDir();
    writeFileSync(
      join(dir, "sign-in.mjs"),
      `
      export default async function signIn({ context }) {
        await context.addCookies([{ name: "session-token", value: "x", url: ${JSON.stringify(server.url)} }]);
      }
      `,
    );
    writeConfig(dir, `signIn: "./sign-in.mjs",`);
    writeWalkthrough(
      dir,
      "persona-a",
      `  persona:
    role: a
    name: Alice
`,
    );
    writeWalkthrough(
      dir,
      "persona-b",
      `  persona:
    role: b
    name: Bob
`,
    );
    // start.persona is nested under start:, fix indentation by rewriting start block directly.
    writeFileSync(
      join(dir, "walkthroughs", "persona-a.yaml"),
      `
walkthrough: persona-a
title: t
start:
  page: /
  persona:
    role: a
    name: Alice
steps:
  - id: noop
    actions:
      - do: expect
        target:
          text: Capture fixture
`,
    );
    writeFileSync(
      join(dir, "walkthroughs", "persona-b.yaml"),
      `
walkthrough: persona-b
title: t
start:
  page: /
  persona:
    role: b
    name: Bob
steps:
  - id: noop
    actions:
      - do: expect
        target:
          text: Capture fixture
`,
    );

    await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });

    const sessionFiles = readdirSync(join(dir, ".build", ".aida-session"));
    expect(sessionFiles.length).toBe(2);
    expect(new Set(sessionFiles).size).toBe(2);
  }, 30_000);
});

describe("runCaptureCommand persona (M26: an admin walkthrough signed in as the adapter's default)", () => {
  function writeStart(dir: string, name: string, start: string): void {
    mkdirSync(join(dir, "walkthroughs"), { recursive: true });
    writeFileSync(
      join(dir, "walkthroughs", `${name}.yaml`),
      `walkthrough: ${name}
title: t
start:
  page: /
${start}
steps:
  - id: noop
    actions:
      - do: expect
        target:
          text: Capture fixture
`,
    );
  }

  it("gives the sign-in adapter a persona object for signed_in_as alone, and one session per role whichever form names it", async () => {
    const dir = tmpProjectDir();
    (globalThis as Record<string, unknown>).__signInPersonas = [];
    writeFileSync(
      join(dir, "sign-in.mjs"),
      `
      export default async function signIn({ context, persona }) {
        globalThis.__signInPersonas.push(persona);
        await context.addCookies([{ name: "session-token", value: "x", url: ${JSON.stringify(server.url)} }]);
      }
      `,
    );
    writeConfig(dir, `signIn: "./sign-in.mjs",`);
    writeStart(dir, "a-shorthand", "  signed_in_as: admin");
    writeStart(dir, "b-persona", "  persona:\n    role: admin");

    await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });

    const personas = (globalThis as Record<string, unknown>).__signInPersonas as unknown[];
    expect(personas[0]).toEqual({ role: "admin" });
    for (const p of personas) expect(typeof p).toBe("object");
    // Same role in either form -> the same storage-state key, so the second reuses the first's session.
    expect(readdirSync(join(dir, ".build", ".aida-session"))).toHaveLength(1);
  }, 30_000);
});
