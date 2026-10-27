// The capture safety gate in `aida build`, `aida ci` and `aida ci --publish` (capture's own
// gate is in capture-gate.test.ts): each refuses before anything is captured, prints the whole
// refusal (message plus every suggestion) in text, and puts the redacted checks in --json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PASSWORD = "gatePassw0rd";
const NEON_MAIN = `postgresql://owner:${PASSWORD}@ep-main-1.us-east-2.aws.neon.tech/neondb`;
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const m of ["impact/index.js", "ci/planned.js"]) vi.doUnmock(`../../src/${m}`);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A aida project whose app directory has `envFiles` and whose config adds `app`. */
function project(envFiles: Record<string, string>, app: Record<string, unknown> = {}): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "aida-gates-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  mkdirSync(join(dir, "app"));
  for (const [name, text] of Object.entries(envFiles)) writeFileSync(join(dir, "app", name), text);
  writeFileSync(
    join(dir, "walkthroughs", "one.yaml"),
    "walkthrough: one\ntitle: t\nstart:\n  page: /\nsteps:\n  - id: s\n    actions:\n      - do: expect\n        target:\n          text: x\n",
  );
  const configPath = join(dir, "aida.config.mjs");
  writeFileSync(
    configPath,
    `export default {
      app: ${JSON.stringify({ baseUrl: "http://127.0.0.1:9", dir: "./app", ...app })},
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
    };`,
  );
  return { dir, configPath };
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m: string) => void err.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return { out, err };
}

/** Every walkthrough affected; the capture step must never be reached. */
function mockCi(): ReturnType<typeof vi.fn> {
  const captureSpy = vi.fn(async () => {
    throw new Error("capture must not run");
  });
  vi.doMock("../../src/impact/index.js", () => ({
    computeAffected: vi.fn(async () => ({ base: "base", head: "HEAD", changedFiles: [], all: true, walkthroughs: [] })),
  }));
  vi.doMock("../../src/ci/planned.js", () => ({ captureInPlannedOrder: captureSpy }));
  return captureSpy;
}

describe("build gate", { timeout: 30_000 }, () => {
  it("refuses an app whose .env points at a live database even with app.database.url set (--json)", async () => {
    vi.resetModules();
    const { dir, configPath } = project({ ".env": `DATABASE_URL=${NEON_MAIN}\n` }, { database: { url: "postgres://demo@127.0.0.1:55432/demo" } });
    const { out } = capture();
    const { runBuild } = await import("../../src/commands/build.js");
    const code = await runBuild({ configPath, walkthroughIds: [] }, true);
    expect(code).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Refusing to capture/);
    expect(parsed.error).toMatch(/ignoreEnv: "\.env:DATABASE_URL#[0-9a-f]{10}"/);
    expect(parsed.database.status).toBe("remote");
    expect(out.join("\n")).not.toContain(PASSWORD);
    expect(existsSync(join(dir, ".build", "one"))).toBe(false);
  });

  it("writes a failed report.json over an older passing one, with the text problems found first", async () => {
    vi.resetModules();
    const { dir, configPath } = project({ ".env": `DATABASE_URL=${NEON_MAIN}\n` });
    writeFileSync(join(dir, "walkthroughs", "long.yaml"), `walkthrough: long\ntitle: t\nsteps:\n  - id: s\n    title: ${"x".repeat(43)}\n`);
    mkdirSync(join(dir, ".build"), { recursive: true });
    writeFileSync(join(dir, ".build", "report.json"), JSON.stringify({ ok: true, walkthroughs: [] }));
    capture();
    const { runBuild } = await import("../../src/commands/build.js");
    expect(await runBuild({ configPath, walkthroughIds: [] }, true)).toBe(1);
    const report = JSON.parse(readFileSync(join(dir, ".build", "report.json"), "utf8"));
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/Refusing to capture/);
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
    const long = report.walkthroughs.find((w: { walkthrough: string }) => w.walkthrough === "long");
    expect(long.failures[0].check).toBe("captions:line-length");
    const { checkBuildReport } = await import("../../src/publish/gates.js");
    expect(checkBuildReport(join(dir, ".build")).ok).toBe(false);
  });

  it("refuses a live Stripe key in text, with the opt-in", async () => {
    vi.resetModules();
    const { configPath } = project({ ".env.local": "STRIPE_SECRET_KEY=sk_live_gatesecret\n", ".env": "DATABASE_URL=postgres://u@localhost/app\n" });
    const { err } = capture();
    const { runBuild } = await import("../../src/commands/build.js");
    const code = await runBuild({ configPath, walkthroughIds: [] }, false);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/LIVE Stripe key/);
    expect(text).toMatch(/allowLivePayments: "\.env\.local:STRIPE_SECRET_KEY#[0-9a-f]{10}"/);
    expect(text).not.toContain("sk_live_gatesecret");
  });
});

describe("ci gate", { timeout: 30_000 }, () => {
  it("prints the full refusal, message and every suggestion, in text", async () => {
    vi.resetModules();
    const captureSpy = mockCi();
    const { configPath } = project({ ".env": `DATABASE_URL=${NEON_MAIN}\n` });
    const { err } = capture();
    const { runCiCli } = await import("../../src/commands/ci.js");
    const code = await runCiCli({ configPath, base: "base", dryRun: true }, false);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/^ci failed:\nRefusing to capture: the app's database is not on this machine/);
    expect(text).toMatch(/\n {2}- .*local database/);
    expect(text).toMatch(/AIDA_THROWAWAY_DATABASE_HOST/);
    expect(text).not.toContain(PASSWORD);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("includes the redacted database check in --json", async () => {
    vi.resetModules();
    const captureSpy = mockCi();
    const { configPath } = project({ ".env": `DATABASE_URL=${NEON_MAIN}\n` });
    const { out } = capture();
    const { runCiCli } = await import("../../src/commands/ci.js");
    const code = await runCiCli({ configPath, base: "base", dryRun: true }, true);
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({ ok: false, database: { status: "remote", refuse: true } });
    expect(parsed.database.findings[0]).toMatchObject({ source: ".env:DATABASE_URL", host: "ep-main-1.us-east-2.aws.neon.tech" });
    expect(parsed.error).toContain("  - ");
    expect(out[0]).not.toContain(PASSWORD);
    expect(out[0]).not.toContain("owner");
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe("ci --publish gate", { timeout: 30_000 }, () => {
  it("refuses before capturing, full text and redacted --json", async () => {
    vi.resetModules();
    const captureSpy = mockCi();
    const { configPath } = project({ ".env": "DATABASE_URL=postgres://u:p@prod-db/app\n" });
    const { out, err } = capture();
    const { runCiPublishCli } = await import("../../src/commands/ci.js");
    expect(await runCiPublishCli({ configPath, base: "base" }, false)).toBe(1);
    expect(err.join("\n")).toMatch(/^ci --publish failed:\nRefusing to capture/);
    expect(err.join("\n")).toMatch(/"prod-db" has no domain/);
    expect(await runCiPublishCli({ configPath, base: "base" }, true)).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.database.findings[0]).toMatchObject({ host: "prod-db", status: "remote" });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("puts the outbound check in --json for a live-payments refusal", async () => {
    vi.resetModules();
    mockCi();
    const { configPath } = project({ ".env": "DATABASE_URL=postgres://u@localhost/app\nSTRIPE_SECRET_KEY=sk_live_gatesecret\n" });
    const { out } = capture();
    const { runCiPublishCli } = await import("../../src/commands/ci.js");
    expect(await runCiPublishCli({ configPath, base: "base" }, true)).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.error).toMatch(/LIVE Stripe key/);
    expect(parsed.database.status).toBe("local");
    expect(parsed.outbound.findings[0]).toMatchObject({ source: ".env:STRIPE_SECRET_KEY", live: true });
    expect(out[0]).not.toContain("sk_live_gatesecret");
  });
});
