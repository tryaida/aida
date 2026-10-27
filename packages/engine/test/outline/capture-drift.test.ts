import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { parseOutline } from "../../src/outline/index.js";
import { startFixtureServer, type FixtureServer } from "../capture/fixture-server.js";

let server: FixtureServer;
const dirs: string[] = [];

beforeEach(async () => {
  server = await startFixtureServer();
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(outline?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-outline-capture-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "add-thing.yaml"),
    `walkthrough: add-thing
title: Add a thing
start:
  page: /
steps:
  - id: add
    actions:
      - do: click
        target: { role: button, name: Add thing }
      - do: expect
        target: { text: "Added:" }
`,
  );
  if (outline) writeFileSync(join(dir, "outline.yaml"), outline);
  return dir;
}

describe("aida capture records outline drift", () => {
  it("writes the difference to the card and prints one line", async () => {
    const dir = project(`# pilot outline
cards:
  - id: add-thing
    title: Add a thing
    labels: ["Save thing"] # from the plan
    status: written
`);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: ["add-thing"], json: true });
    expect(code).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dir, ".build", "add-thing", "capture", "manifest.json"), "utf8"));
    expect(manifest.steps[0].targets).toEqual(["Add thing", "Added:"]);

    const text = readFileSync(join(dir, "outline.yaml"), "utf8");
    expect(text).toContain("# from the plan");
    const card = parseOutline(text).outline.cards[0];
    expect(card.status).toBe("captured");
    // `seen` holds the real on-screen names, so the close real name is suggested.
    expect(manifest.steps[0].seen).toContain("Add thing");
    expect(card.drift).toMatchObject([{ expected: "Save thing", seen: "Add thing", step: "add", source: "capture" }]);
    expect(errors.filter((l) => l.startsWith("outline:"))).toEqual([
      'outline: add-thing: 1 name on the card differs from the screen: "Save thing" (saw "Add thing" at step add)',
    ]);
    expect(existsSync(join(dir, "outline.yaml.lock"))).toBe(false);
  }, 60_000);

  it("is a quiet no-op when the outline has no card for the walkthrough", async () => {
    const outline = "cards:\n  - id: other-thing\n    title: Another thing\n    status: planned\n";
    const dir = project(outline);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: ["add-thing"], json: true })).toBe(0);
    expect(readFileSync(join(dir, "outline.yaml"), "utf8")).toBe(outline);
    expect(errors.some((l) => l.startsWith("outline:"))).toBe(false);
  }, 60_000);

  it("is quiet and creates nothing without an outline file", async () => {
    const dir = project();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: ["add-thing"], json: true })).toBe(0);
    expect(existsSync(join(dir, "outline.yaml"))).toBe(false);
    expect(errors.some((l) => l.startsWith("outline:"))).toBe(false);
  }, 60_000);
});
