// outline.yaml writes from several processes at once (M29 review): `outline note` used to be an
// unlocked read-modify-write, so parallel calls all printed success but some notes were lost.
// Also: the missing-card note, `outline list`'s "no walkthrough yet", and comments inside `drift:`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOutlineList, runOutlineNote } from "../../src/commands/outline.js";
import { parseOutline, readOutline, setDrift, updateOutline, withOutlineLock, LOCK_STALE_MS } from "../../src/outline/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..", "..");
const cliTs = join(repoRoot, "packages", "engine", "src", "cli.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(outline?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-outline-file-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: "http://127.0.0.1:9" }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  if (outline !== undefined) writeFileSync(join(dir, "outline.yaml"), outline);
  return dir;
}

const WALKTHROUGH = (id: string, title: string) => `walkthrough: ${id}
title: ${title}
steps:
  - id: open
    do: click "Settings" button
`;

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, cliTs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  return { out, err };
}

describe("parallel outline note", () => {
  it("keeps every note when 10 `aida outline note` processes run at once", async () => {
    const dir = project("# pilot\ncards:\n  - id: add-session # keep me\n    title: Add a session\n    status: planned\n");
    const config = join(dir, "aida.config.mjs");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => run(["outline", "note", "add-session", `note ${i}`, "--config", config, "--json"])));
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const text = readFileSync(join(dir, "outline.yaml"), "utf8");
    expect(text).toContain("# keep me");
    const notes = parseOutline(text).outline.cards[0].notes ?? [];
    expect([...notes].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `note ${i}`).sort());
    expect(existsSync(join(dir, "outline.yaml.lock"))).toBe(false);
  }, 120_000);
});

describe("outline lock", () => {
  it("breaks a lock left by a dead process, and one older than the stale age", () => {
    const dir = project("cards: []\n");
    const file = join(dir, "outline.yaml");
    const lock = `${file}.lock`;
    // A pid that can't be running (above the kernel's pid_max).
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, host: hostname(), at: Date.now(), token: "dead" }));
    expect(withOutlineLock(file, () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);

    // Held by this (live) process but long ago.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - LOCK_STALE_MS - 1_000, token: "old" }));
    expect(withOutlineLock(file, () => "ran again")).toBe("ran again");

    // Garbled (its writer died between open and write): judged by the file's age.
    writeFileSync(lock, "");
    const old = (Date.now() - LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(lock, old, old);
    expect(withOutlineLock(file, () => "and again")).toBe("and again");
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock when the update throws, and takes none without an outline file", () => {
    const dir = project("cards: []\n");
    const file = join(dir, "outline.yaml");
    expect(() =>
      updateOutline(file, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${file}.lock`)).toBe(false);
    const empty = project();
    expect(updateOutline(join(empty, "outline.yaml"), (loaded) => loaded)).toBeNull();
    expect(existsSync(join(empty, "outline.yaml.lock"))).toBe(false);
  });

  it("re-reads a file that doesn't parse, so a reader racing a non-atomic writer sees the finished file", async () => {
    const dir = project("cards:\n  - id: add-session\n    title: [half written\n");
    const file = join(dir, "outline.yaml");
    // Another process finishes the write ~50ms after it says it's ready; readOutline (sync)
    // retries meanwhile.
    const fixed = "cards:\n  - id: add-session\n    title: Add a session\n";
    const child = spawn(process.execPath, [
      "-e",
      `process.stdout.write("ready\\n"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(fixed)}), 50)`,
    ]);
    await new Promise((r) => child.stdout.once("data", r));
    expect(readOutline(file)!.outline.cards[0].title).toBe("Add a session");
    await new Promise((r) => child.on("close", r));
  });
});

describe("outline note on a walkthrough with no card", () => {
  it("adds a minimal card (title from the walkthrough, status written) and says so", async () => {
    const dir = project("cards:\n  - id: other\n    title: Other\n    status: planned\n");
    writeFileSync(join(dir, "walkthroughs", "new-thing.yaml"), WALKTHROUGH("new-thing", "Make a new thing"));
    const { out } = capture();
    expect(await runOutlineNote({ configPath: join(dir, "aida.config.mjs"), id: "new-thing", text: 'No "Undo" button', json: false })).toBe(0);
    expect(out[0]).toMatch(/no card for new-thing in the outline; added one \(status written, title "Make a new thing"\)/);
    const added = parseOutline(readFileSync(join(dir, "outline.yaml"), "utf8")).outline.cards[1];
    expect(added).toMatchObject({ id: "new-thing", title: "Make a new thing", status: "written", notes: ['No "Undo" button'] });
    expect(added.drift).toMatchObject([{ expected: "Undo", source: "writer" }]);
  });

  it("still refuses an id that can't be a walkthrough id", async () => {
    const dir = project("cards: []\n");
    capture();
    expect(await runOutlineNote({ configPath: join(dir, "aida.config.mjs"), id: "Not An Id", text: "x", json: false })).toBe(1);
  });
});

describe("outline list", () => {
  it("marks a card whose id matches no walkthrough as having no walkthrough yet", async () => {
    const dir = project("cards:\n  - id: written-one\n    title: Written\n    status: written\n  - id: planned-one\n    title: Planned\n    status: planned\n");
    writeFileSync(join(dir, "walkthroughs", "written-one.yaml"), WALKTHROUGH("written-one", "Written"));
    const { out } = capture();
    expect(await runOutlineList({ configPath: join(dir, "aida.config.mjs"), json: false })).toBe(0);
    expect(out.find((l) => l.includes("written-one"))).not.toMatch(/no walkthrough yet/);
    expect(out.find((l) => l.includes("planned-one"))).toMatch(/no walkthrough yet/);
    out.length = 0;
    expect(await runOutlineList({ configPath: join(dir, "aida.config.mjs"), json: true })).toBe(0);
    expect(JSON.parse(out[0]).cards.map((c: { id: string; walkthrough: boolean }) => [c.id, c.walkthrough])).toEqual([
      ["written-one", true],
      ["planned-one", false],
    ]);
  });
});

describe("setDrift keeps comments inside drift:", () => {
  it("updates entries in place, keeping comments on the key and on entries that stay", () => {
    const dir = project(`cards:
  - id: add-session
    title: Add a session
    status: captured
    # what capture found
    drift:
      # the plan said Save
      - expected: Save session # from the plan
        seen: Add sessions
        at: t0
        source: capture
      - expected: Gone label
        at: t0
        source: capture
`);
    const file = join(dir, "outline.yaml");
    updateOutline(file, (loaded) =>
      setDrift(loaded!.doc, "add-session", [
        { expected: "Save session", seen: "Add session", step: "add", at: "t0", source: "capture" },
        { expected: "Register", at: "t1", source: "writer" },
      ]),
    );
    const text = readFileSync(file, "utf8");
    for (const c of ["# what capture found", "# the plan said Save", "# from the plan"]) expect(text).toContain(c);
    expect(parseOutline(text).outline.cards[0].drift).toEqual([
      { expected: "Save session", seen: "Add session", step: "add", at: "t0", source: "capture" },
      { expected: "Register", at: "t1", source: "writer" },
    ]);
  });
});
