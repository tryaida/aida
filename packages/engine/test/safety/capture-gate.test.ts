// The capture safety gate stops the whole `aida capture` run before any browser opens, and
// reports it like a run-level error (one JSON object with --json).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { resetAppDatabaseWarnings } from "../../src/safety/index.js";

const PASSWORD = "gatePassw0rd";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetAppDatabaseWarnings();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(databaseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-gate-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "one.yaml"),
    "walkthrough: one\ntitle: t\nstart:\n  page: /\nsteps:\n  - id: s\n    actions:\n      - do: expect\n        target:\n          text: x\n",
  );
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default {
      app: { baseUrl: "http://127.0.0.1:9", database: { url: ${JSON.stringify(databaseUrl)} } },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
    };`,
  );
  return dir;
}

describe("capture safety gate", () => {
  it("refuses a remote app database before capturing anything (--json)", async () => {
    const dir = project(`postgresql://owner:${PASSWORD}@ep-main-1.us-east-2.aws.neon.tech/neondb`);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(m));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Refusing to capture/);
    expect(parsed.database.status).toBe("remote");
    expect(out[0]).not.toContain(PASSWORD);
    expect(existsSync(join(dir, ".build", "one"))).toBe(false);
  });

  it("prints the refusal in plain words without --json", async () => {
    const dir = project(`postgresql://owner:${PASSWORD}@ep-main-1.us-east-2.aws.neon.tech/neondb`);
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: string) => void err.push(m));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: false });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Neon database/);
    expect(err.join("\n")).not.toContain(PASSWORD);
  });
});
