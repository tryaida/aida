import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";
import { runRecordCommand } from "../../src/commands/record.js";
import { loadWalkthroughFile } from "../../src/walkthrough/index.js";
import { startFixtureServer, type FixtureServer } from "../capture/fixture-server.js";

const TEST_TIMEOUT = 120_000;
const createdDirs: string[] = [];
let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function project(): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "aida-record-test-"));
  createdDirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  const config = join(dir, "aida.config.mjs");
  writeFileSync(
    config,
    `export default {
      app: { baseUrl: ${JSON.stringify(server.url)} },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
    };\n`,
  );
  return { dir, config };
}

/** Lets the binding round-trips the page started finish before the next action. */
const tick = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("aida record", () => {
  it(
    "turns a click-through into a draft that passes schema validation and replays",
    async () => {
      const { dir, config } = project();
      const code = await runRecordCommand({
        configPath: config,
        id: "add-a-competitor",
        page: "/record-list.html",
        headless: true,
        json: true,
        // At a person's pace: each target is worked out before the click that leaves the page.
        drive: async (page, recorder) => {
          await page.getByRole("link", { name: "Add competitor" }).hover();
          await tick(300);
          await recorder.settled();
          await page.getByRole("link", { name: "Add competitor" }).click();
          await page.waitForURL(/record-form/);
          await tick();
          await page.getByLabel("First name").fill("Jordan");
          await page.getByLabel("Email").fill("jordan.smith@gmail.com");
          await page.getByLabel("Class").selectOption("Junior");
          await page.getByLabel("Paid").check();
          await tick();
          await page.evaluate(() => (window as unknown as { __aidaRecorderTool: (n: string, v?: string) => void }).__aidaRecorderTool("note", "Fill in who they are."));
          await page.getByRole("button", { name: "Save competitor" }).hover();
          await tick(300);
          await recorder.settled();
          await page.getByRole("button", { name: "Save competitor" }).click();
          await page.waitForURL(/record-done/);
          await tick();
          await page.evaluate(() => (window as unknown as { __aidaRecorderTool: (n: string) => void }).__aidaRecorderTool("expect"));
          await page.getByRole("heading", { name: "Competitor added" }).click();
          await tick(400);
        },
      });

      const file = join(dir, "walkthroughs", "add-a-competitor.yaml");
      const text = readFileSync(file, "utf8");
      expect(text).toContain("DRAFT — recorded with `aida record`");
      const doc = YAML.parse(text);
      expect(doc.start).toEqual({ page: "/record-list.html" });
      // The email typed was swapped for a safe one before it reached the file.
      expect(text).not.toContain("gmail.com");
      expect(doc.data).toEqual({ firstName: "Jordan", email: "person@example.com" });

      const steps = doc.steps as { id: string; title: string; say: string; actions: Record<string, unknown>[] }[];
      expect(steps.map((s) => s.id)).toEqual(["open-add-competitor", "fill-in-first-name-email", "click-save-competitor"]);
      expect(steps[0].actions).toEqual([
        { do: "click", target: { role: "link", name: "Add competitor" } },
        { do: "waitForUrl", pattern: "^[^?#]*://[^/]+/record-form\\.html(?:[?#].*)?$" },
      ]);
      expect(steps[1].say).toBe("Fill in who they are.");
      expect(steps[1].actions).toEqual([
        { do: "type", target: { label: "First name" }, text: "{{firstName}}" },
        { do: "type", target: { label: "Email" }, text: "{{email}}" },
        { do: "select", target: { label: "Class" }, option: "Junior" },
        { do: "click", target: { label: "Paid" } },
      ]);
      expect(steps[2].actions).toEqual([
        { do: "click", target: { role: "button", name: "Save competitor" } },
        { do: "waitForUrl", pattern: "^[^?#]*://[^/]+/record-done\\.html(?:[?#].*)?$" },
        { do: "expect", target: { role: "heading", name: "Competitor added" } },
      ]);
      expect(text).not.toContain("TODO: check this target");

      // A real walkthrough file, and its one replay passed.
      expect(loadWalkthroughFile(file).steps).toHaveLength(3);
      const out = JSON.parse((console.log as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)![0]);
      expect(out).toMatchObject({ ok: true, steps: 3, unverified: 0, replay: { ok: true } });
      expect(out.swapped).toEqual(['email in "Email"']);
      expect(code).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "scopes a button that repeats on the page to its row",
    async () => {
      const { dir, config } = project();
      const code = await runRecordCommand({
        configPath: config,
        id: "edit-a-competitor",
        page: "/record-list.html",
        headless: true,
        json: true,
        drive: async (page) => {
          await page.getByRole("row", { name: "Sam Lee" }).getByRole("button", { name: "Edit" }).click();
          await tick();
          await page.evaluate(() => (window as unknown as { __aidaRecorderTool: (n: string) => void }).__aidaRecorderTool("point"));
          await page.getByText("Editing Sam Lee").click();
          await tick(400);
        },
      });
      expect(code).toBe(0);
      const doc = YAML.parse(readFileSync(join(dir, "walkthroughs", "edit-a-competitor.yaml"), "utf8"));
      expect(doc.steps[0].actions).toEqual([{ do: "click", target: { role: "button", name: "Edit", within: { role: "row", name: "Sam Lee" } } }]);
      expect(doc.steps[1].actions).toEqual([{ do: "point", target: { text: "Editing Sam Lee" }, highlight: true }]);
    },
    TEST_TIMEOUT,
  );

  it("refuses to overwrite an existing walkthrough, before any browser opens", async () => {
    const { dir, config } = project();
    writeFileSync(join(dir, "walkthroughs", "taken.yaml"), "walkthrough: taken\n");
    const drive = vi.fn();
    const code = await runRecordCommand({ configPath: config, id: "taken", headless: true, json: true, drive });
    expect(code).toBe(1);
    expect(drive).not.toHaveBeenCalled();
    const out = JSON.parse((console.log as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)![0]);
    expect(out.error).toMatch(/already exists/);
  });

  it(
    "writes nothing when nothing was recorded",
    async () => {
      const { dir, config } = project();
      const code = await runRecordCommand({ configPath: config, id: "empty", page: "/record-list.html", headless: true, json: true, drive: async () => {} });
      expect(code).toBe(1);
      expect(() => readFileSync(join(dir, "walkthroughs", "empty.yaml"))).toThrow();
    },
    TEST_TIMEOUT,
  );
});
