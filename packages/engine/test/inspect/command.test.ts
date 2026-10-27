import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInspectCommand } from "../../src/commands/inspect.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const createdDirs: string[] = [];
let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function tmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-inspect-command-test-"));
  createdDirs.push(dir);
  return dir;
}

function writeConfig(dir: string): string {
  const file = join(dir, "aida.config.mjs");
  writeFileSync(
    file,
    `export default {
      app: { baseUrl: ${JSON.stringify(server.url)} },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
    };\n`,
  );
  return file;
}

function writeWalkthrough(dir: string): void {
  mkdirSync(join(dir, "walkthroughs"), { recursive: true });
  writeFileSync(
    join(dir, "walkthroughs", "demo.yaml"),
    `walkthrough: demo
title: Demo
start:
  signed_in_as: office_staff
  persona:
    role: office_staff
    name: Jordan
  page: /index.html
steps:
  - id: noop
    actions:
      - do: expect
        target:
          text: Add new competitor
`,
  );
}

describe("runInspectCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints a JSON result with the page's interactive elements", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const code = await runInspectCommand({ configPath: config, path: "/index.html" }, true);

    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot).toMatch(/button "Create Competitor"/);
    expect(payload.snapshot).toContain("[required]");
  }, 30_000);

  it("resolves --as to the matching walkthrough's persona", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const code = await runInspectCommand({ configPath: config, path: "/index.html", as: "office_staff" }, true);
    expect(code).toBe(0);
  }, 30_000);

  it("fails cleanly for an --as that matches no walkthrough", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const code = await runInspectCommand({ configPath: config, path: "/index.html", as: "nobody" }, true);
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.error).toMatch(/no walkthrough/);
  }, 30_000);

  it("scopes with --area", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const code = await runInspectCommand({ configPath: config, path: "/index.html", area: "nav" }, true);
    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.snapshot).not.toContain("Create Competitor");
  }, 30_000);

  it("opens a menu with --click, and refuses a submit-shaped --click name", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const opened = await runInspectCommand({ configPath: config, path: "/index.html", click: "Open menu" }, true);
    expect(opened).toBe(0);
    const openedPayload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(openedPayload.snapshot).toContain("Record Payment");

    logSpy.mockClear();
    const refused = await runInspectCommand({ configPath: config, path: "/index.html", click: "Create Competitor" }, true);
    expect(refused).toBe(1);
    const refusedPayload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(refusedPayload.refused).toBe(true);
  }, 30_000);

  it(
    "allows --click on a dialog opener whose name looks write-shaped by name alone " +
      "(bug: 'Add mob' used to be refused for containing 'add', same as a real write button)",
    async () => {
      const dir = tmpProjectDir();
      const config = writeConfig(dir);
      writeWalkthrough(dir);

      const code = await runInspectCommand({ configPath: config, path: "/index.html", click: "Add mob" }, true);
      expect(code).toBe(0);
      const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(payload.click.dialogOpened).toBe(true);
      expect(payload.click.warning).toMatch(/write-shaped/);
      expect(payload.snapshot).toContain("Mob name");
    },
    30_000,
  );

  it(
    "blocks a non-GET request a click fires at the network layer — it never reaches the server",
    async () => {
      const dir = tmpProjectDir();
      const config = writeConfig(dir);
      writeWalkthrough(dir);

      const code = await runInspectCommand({ configPath: config, path: "/index.html", click: "Quick add" }, true);
      expect(code).toBe(0);
      const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(payload.click.blockedWrite).toBe(true);
      expect(payload.click.dialogOpened).toBe(false);
      expect(server.postCount).toBe(0);
    },
    30_000,
  );

  it("--check reveals a conditionally-shown field", async () => {
    const dir = tmpProjectDir();
    const config = writeConfig(dir);
    writeWalkthrough(dir);

    const code = await runInspectCommand({ configPath: config, path: "/index.html", check: "Has mob" }, true);
    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.snapshot).toContain("Mob size");
  }, 30_000);
});
