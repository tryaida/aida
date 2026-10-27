// M28: `aida inspect` chains `--click`, and `--walkthrough <id> --after <step>` replays a
// walkthrough's real actions up to that step (this mode writes) before scanning. Both, and plain
// inspect, refuse a remote app database exactly as capture does (decision 27).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInspectCommand } from "../../src/commands/inspect.js";
import { resetAppDatabaseWarnings } from "../../src/safety/index.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
const createdDirs: string[] = [];
let server: FixtureServer;
let out: string[];

beforeEach(async () => {
  server = await startFixtureServer();
  out = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(m));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetAppDatabaseWarnings();
  await server.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

/** A project with one walkthrough: type a name, save (a real POST), then a step that would fail. */
function project(appExtra = ""): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "aida-inspect-after-test-"));
  createdDirs.push(dir);
  const config = join(dir, "aida.config.mjs");
  writeFileSync(
    config,
    `export default {
      app: { baseUrl: ${JSON.stringify(server.url)}${appExtra} },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
    };\n`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "register.yaml"),
    `walkthrough: register
title: Register someone
start:
  signed_in_as: office_staff
  page: /after.html
steps:
  - id: fill
    actions:
      - do: type
        target:
          label: Name
        text: Ada Lovelace
  - id: save
    actions:
      - do: click
        target:
          role: button
          name: Save
          exact: true
      - do: waitFor
        target:
          text: Registration saved
  - id: missing
    actions:
      - do: click
        target:
          role: button
          name: Not on this page
`,
  );
  return { dir, config };
}

const payload = (): Record<string, unknown> => JSON.parse(out[out.length - 1]);

describe("inspect --click, chained", () => {
  it(
    "runs several clicks in order: a menu, then the item that opens a dialog",
    async () => {
      const { config } = project();
      const code = await runInspectCommand({ configPath: config, path: "/after.html", click: ["More actions", "Edit registration"] }, true);
      expect(code).toBe(0);
      const p = payload() as { snapshot: string; clicks: { name: string; dialogOpened: boolean }[]; click: { dialogOpened: boolean } };
      expect(p.clicks.map((c) => c.name)).toEqual(["More actions", "Edit registration"]);
      expect(p.clicks[1].dialogOpened).toBe(true);
      expect(p.click.dialogOpened).toBe(true);
      expect(p.snapshot).toContain("Notes");
    },
    TIMEOUT,
  );

  it(
    "still refuses a submit-shaped click anywhere in the chain",
    async () => {
      const { config } = project();
      const code = await runInspectCommand({ configPath: config, path: "/after.html", click: ["More actions", "Submit registration"] }, true);
      expect(code).toBe(1);
      expect(payload().refused).toBe(true);
      expect(server.postCount).toBe(0);
    },
    TIMEOUT,
  );
});

describe("inspect --walkthrough --after", () => {
  it(
    "replays up to and including the named step, really saving, then scans that page",
    async () => {
      const { dir, config } = project();
      const code = await runInspectCommand({ configPath: config, walkthrough: "register", after: "save" }, true);
      expect(code).toBe(0);
      const p = payload() as { ok: boolean; snapshot: string; after: unknown };
      expect(p.ok).toBe(true);
      expect(p.after).toEqual({ walkthrough: "register", step: "save" });
      expect(p.snapshot).toContain("Registration saved");
      // The save really went to the server; the later, broken step never ran.
      expect(server.postCount).toBe(1);
      // Nothing recorded: no frames, no failure.json.
      expect(existsSync(join(dir, ".build", "register"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "stops at an earlier step when asked, before the save",
    async () => {
      const { dir, config } = project();
      const code = await runInspectCommand({ configPath: config, walkthrough: join(dir, "walkthroughs", "register.yaml"), after: "fill" }, true);
      expect(code).toBe(0);
      expect(payload().snapshot).not.toContain("Registration saved");
      expect(server.postCount).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "takes --click after the replay, with writes blocked again for the scan",
    async () => {
      const { config } = project();
      const code = await runInspectCommand(
        { configPath: config, walkthrough: "register", after: "save", click: ["More actions", "Edit registration"], area: "dialog" },
        true,
      );
      expect(code).toBe(0);
      expect(payload().snapshot).toContain("Notes");
      expect(server.postCount).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "prints the classified failure report when a step on the way fails",
    async () => {
      const { config } = project();
      const code = await runInspectCommand({ configPath: config, walkthrough: "register", after: "missing", maxWaitMs: 1_500 }, true);
      expect(code).toBe(1);
      const p = payload() as { ok: boolean; failure: { step: string; category: string; reason: string } };
      expect(p.ok).toBe(false);
      expect(p.failure.step).toBe("missing");
      expect(p.failure.category).toBe("walkthrough");
      expect(p.failure.reason).toMatch(/never found/);
    },
    TIMEOUT,
  );

  it("names the steps when --after doesn't match one", async () => {
    const { config } = project();
    const code = await runInspectCommand({ configPath: config, walkthrough: "register", after: "nope" }, true);
    expect(code).toBe(1);
    expect(payload().error).toBe('no step "nope" in walkthrough register (steps: fill, save, missing)');
  });
});

describe("inspect safety gate (decision 27)", () => {
  const REMOTE = `, database: { url: "postgresql://owner:pw@ep-main-1.us-east-2.aws.neon.tech/neondb" }`;

  it("refuses --after under a remote app database, before anything runs", async () => {
    const { dir, config } = project(REMOTE);
    const code = await runInspectCommand({ configPath: config, walkthrough: "register", after: "save" }, true);
    expect(code).toBe(1);
    const p = payload() as { ok: boolean; error: string; database: { status: string } };
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/Refusing to capture/);
    expect(p.database.status).toBe("remote");
    expect(server.postCount).toBe(0);
    expect(existsSync(join(dir, ".build"))).toBe(false);
  });

  it("refuses plain inspect too: signing in can write", async () => {
    const { config } = project(REMOTE);
    const code = await runInspectCommand({ configPath: config, path: "/after.html" }, true);
    expect(code).toBe(1);
    expect(payload().error).toMatch(/Refusing to capture/);
  });
});
