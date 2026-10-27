import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWhatsNew } from "../../src/commands/whats-new.js";

// `runWhatsNew` loads a real aida.config.(m)js via the engine's config loader (same as every
// other `--config` command) — a plain `.mjs` with `helpApp` set is enough, no `defineConfig`
// import needed since that's just an identity helper (config/define.ts).
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeAppRepo(): { appRepo: string; configPath: string; helpApp: string } {
  dir = mkdtempSync(join(tmpdir(), "aida-whats-new-cmd-"));
  const appRepo = dir;
  const helpApp = join(appRepo, "help");
  mkdirSync(join(helpApp, "public"), { recursive: true });
  const configPath = join(appRepo, "aida.config.mjs");
  writeFileSync(
    configPath,
    `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", outDir: "./.build-out", buildDir: "./.build", helpApp: "./help" };\n`,
  );
  return { appRepo, configPath, helpApp };
}

describe("runWhatsNew", () => {
  it("fails with a clear error when config.helpApp isn't set", async () => {
    dir = mkdtempSync(join(tmpdir(), "aida-whats-new-cmd-nohelp-"));
    const configPath = join(dir, "aida.config.mjs");
    writeFileSync(configPath, `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs" };\n`);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runWhatsNew({ configPath }, true);
    expect(code).toBe(1);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.error).toMatch(/helpApp/);
    logSpy.mockRestore();
  });

  it("fails with a clear error when the config file doesn't exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "aida-whats-new-cmd-missing-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runWhatsNew({ configPath: join(dir, "nope.config.mjs") }, true);
    expect(code).toBe(1);
    logSpy.mockRestore();
  });

  it("builds the page from the app repo the config file lives in (git log run there, not cwd)", async () => {
    const { configPath, helpApp } = makeAppRepo();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // No real git repo at `appRepo`, so `git log` itself fails — exercising the command's own
    // error path end-to-end without needing a real git history fixture.
    const code = await runWhatsNew({ configPath }, true);
    expect(code).toBe(1);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.error).toMatch(/git log failed/);
    logSpy.mockRestore();
    expect(() => readFileSync(join(helpApp, "content", "docs", "whats-new", "index.mdx"))).toThrow();
  });
});
