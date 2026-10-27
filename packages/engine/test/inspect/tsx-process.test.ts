// Runs `aida inspect` the way AGENTS.md documents agents using it in dev — `npx tsx
// packages/engine/src/cli.ts inspect ...` — as a real child process, not through vitest's own
// module runner. Vitest's transform doesn't reproduce tsx's "keep names for stack traces"
// rewrite (see inspect/snapshot.ts's COLLECT_REQUIRED_NAMES_SCRIPT comment), so a bug that only
// shows up under tsx (the `ReferenceError: __name is not defined` a named helper nested inside a
// `page.evaluate()` callback used to throw) would otherwise never be caught by the suite —
// exactly the gap that let it ship.
//
// Uses `child_process.spawn` (async), not `execFileSync`/`spawnSync`: a synchronous spawn whose
// child launches Chromium deadlocks here — `spawnSync`'s pipe read waits for every process
// holding the stdout/stderr pipe open to exit, and one of Chromium's own helper processes
// (zygote/gpu/utility) can still be winding down after the `tsx` process itself has already
// printed its result and exited, so the read never sees EOF. Confirmed directly: the identical
// command hung indefinitely under `execFileSync` and finished in ~5s under `spawn`.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(__dirname, "..", "..");
const cliTs = join(engineRoot, "src", "cli.ts");

const createdDirs: string[] = [];
let server: FixtureServer;

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-inspect-tsx-test-"));
  createdDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function writeConfig(dir: string): string {
  const file = join(dir, "aida.config.mjs");
  mkdirSync(join(dir, "walkthroughs"), { recursive: true });
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

/** Runs `npx tsx <args>` as a real child process, async, returning its stdout once it exits.
 * Kills the child (and its process group) if it outlives `timeoutMs`, so a regression that
 * hangs fails the test in seconds instead of hanging the suite. */
function runTsx(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`npx tsx ${args.join(" ")} timed out after ${timeoutMs}ms; stdout so far: ${stdout.slice(0, 500)}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

describe("aida inspect under `npx tsx` (real process, no page errors)", () => {
  it("prints a snapshot with no __name/ReferenceError, same as the compiled CLI", async () => {
    const dir = tmpDir();
    const config = writeConfig(dir);

    const { stdout, code } = await runTsx(
      [cliTs, "inspect", "/index.html", "--config", config, "--json"],
      engineRoot,
    );

    expect(code).toBe(0);
    expect(stdout).not.toMatch(/__name is not defined/);
    expect(stdout).not.toMatch(/ReferenceError/);
    const payload = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot).toMatch(/button "Create Competitor"/);
    expect(payload.snapshot).toContain("[required]");
  }, 45_000);

  it("also works scoped with --area and after --click, under tsx", async () => {
    const dir = tmpDir();
    const config = writeConfig(dir);

    const { stdout, code } = await runTsx(
      [cliTs, "inspect", "/index.html", "--config", config, "--click", "Open menu", "--json"],
      engineRoot,
    );

    expect(code).toBe(0);
    expect(stdout).not.toMatch(/__name is not defined/);
    const payload = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot).toContain("Record Payment");
  }, 45_000);
});
