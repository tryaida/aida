import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBaseUrl,
  checkChromiumLaunch,
  checkConfig,
  aidaCommand,
  checkDatabase,
  checkDisk,
  checkFfmpeg,
  checkFfprobe,
  checkHelpApp,
  checkNextCache,
  checkNode,
  checkOutboundSenders,
  checkPlaywright,
  formatDoctor,
  runDoctor,
} from "../../src/doctor/index.js";
import type { DoctorProbes } from "../../src/doctor/index.js";
import { checkAppDatabase, checkOutbound } from "../../src/safety/index.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("doctor checks", () => {
  it("Node: 22+ ok, older fails with a fix", () => {
    expect(checkNode("22.1.0").status).toBe("ok");
    expect(checkNode("v24.0.0").status).toBe("ok");
    const old = checkNode("20.11.1");
    expect(old.status).toBe("fail");
    expect(old.fix).toMatch(/nvm install 22/);
  });

  it("ffmpeg: system, then ffmpeg-static, else fail; ffprobe needs PATH", () => {
    expect(checkFfmpeg("ffmpeg version 8", undefined, "linux").status).toBe("ok");
    expect(checkFfmpeg(undefined, "/x/ffmpeg", "linux")).toMatchObject({ status: "ok", detail: expect.stringMatching(/ffmpeg-static/) });
    expect(checkFfmpeg(undefined, undefined, "linux")).toMatchObject({ status: "fail", fix: "sudo apt-get install -y ffmpeg" });
    expect(checkFfmpeg(undefined, undefined, "darwin").fix).toBe("brew install ffmpeg");
    expect(checkFfprobe(undefined, "linux").status).toBe("fail");
    expect(checkFfprobe("ffprobe version 8", "linux").status).toBe("ok");
  });

  it("Playwright: missing package, missing browser build, ok", () => {
    expect(checkPlaywright(undefined)).toMatchObject({ status: "fail", fix: "npm install playwright" });
    const missing = checkPlaywright({ version: "1.64.1", chromiumRevision: "1248", chromiumPath: "/c/chrome", chromiumInstalled: false });
    expect(missing).toMatchObject({ status: "fail", fix: "npx playwright install chromium" });
    expect(missing.detail).toMatch(/1\.64\.1 needs Chromium build 1248/);
    expect(checkPlaywright({ version: "1.64.1", chromiumPath: "/c", chromiumInstalled: true }).status).toBe("ok");
  });

  it("Chromium launch: names a missing shared library and suggests install-deps", () => {
    const r = checkChromiumLaunch({
      ok: false,
      error: "browserType.launch: Target page, context or browser has been closed\n/x/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("libnss3.so");
    expect(r.fix).toBe("sudo npx playwright install-deps chromium");
    expect(checkChromiumLaunch({ ok: false, error: "Host system is missing dependencies to run browsers." }).fix).toMatch(/install-deps/);
    expect(checkChromiumLaunch({ ok: false, error: "Executable doesn't exist at /x" }).fix).toBe("npx playwright install chromium");
    expect(checkChromiumLaunch({ ok: true }).status).toBe("ok");
    expect(checkChromiumLaunch(undefined).status).toBe("skip");
  });

  it("disk: fail under 1 GB, warn under 5 GB", () => {
    expect(checkDisk("/b", 0.5 * GB).status).toBe("fail");
    expect(checkDisk("/b", 3 * GB).status).toBe("warn");
    expect(checkDisk("/b", 50 * GB).status).toBe("ok");
    expect(checkDisk("/b", undefined).status).toBe("warn");
  });

  it(".next cache: warn over 1 GB and suggest a production build", () => {
    const big = checkNextCache("/app", { bytes: 1.7 * GB, truncated: true });
    expect(big.status).toBe("warn");
    expect(big.detail).toMatch(/next build && next start/);
    expect(big.fix).toBe("rm -rf /app/.next/cache");
    expect(checkNextCache("/app", { bytes: 200 * 1024 ** 2, truncated: false }).status).toBe("ok");
    expect(checkNextCache("/app", undefined).status).toBe("ok");
    expect(checkNextCache(undefined, undefined).status).toBe("skip");
  });

  it("config: missing is a skip unless asked for; a load error fails", () => {
    expect(checkConfig(undefined, undefined, false).status).toBe("skip");
    expect(checkConfig(undefined, undefined, false).fix).toBe(`${aidaCommand()} init <app-dir>`);
    expect(checkConfig(undefined, undefined, true).status).toBe("fail");
    expect(checkConfig("/c.mjs", "config.app.baseUrl is required", false).status).toBe("fail");
    expect(checkConfig("/c.mjs", undefined, false).status).toBe("ok");
  });

  it("baseUrl: any HTTP answer (even an error status) is ok; unreachable warns", () => {
    expect(checkBaseUrl("http://127.0.0.1:3000", { status: 307 }).status).toBe("ok");
    expect(checkBaseUrl("http://127.0.0.1:3000", { status: 500 }).status).toBe("ok");
    const refused = checkBaseUrl("http://127.0.0.1:3000", { error: "ECONNREFUSED" });
    expect(refused.status).toBe("warn");
    expect(refused.detail).toMatch(/didn't answer \(ECONNREFUSED\)/);
    const timedOut = checkBaseUrl("http://127.0.0.1:3100", { error: "TimeoutError" });
    expect(timedOut.status).toBe("warn");
    expect(timedOut.detail).toMatch(/didn't answer within 20 s \(a dev server may still be compiling/);
    expect(timedOut.detail).toMatch(/next build && next start/);
  });

  it("database: remote fails, unknown warns, local ok", async () => {
    const remote = checkDatabase(await checkAppDatabase({ env: { DATABASE_URL: "postgres://u:pw@ep-a.neon.tech/db" } }));
    expect(remote.status).toBe("fail");
    expect(remote.detail).toMatch(/capture will refuse/);
    expect(checkDatabase(await checkAppDatabase({ env: {} })).status).toBe("warn");
    expect(checkDatabase(await checkAppDatabase({ env: { DATABASE_URL: "postgres://u@localhost/db" } })).status).toBe("ok");
  });

  it("database: a local app.database.url over remote env files suggests ignoreEnv by name, not throwaway (M36)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-doctor-db-"));
    dirs.push(dir);
    const remoteUrl = "postgresql://acme_owner:pw@ep-acme-123456.us-east-2.aws.neon.tech/acme";
    writeFileSync(join(dir, ".env"), `DATABASE_URL=${remoteUrl}\nDATABASE_URL_DIRECT=${remoteUrl}\n`);
    const check = await checkAppDatabase({
      config: { app: { dir, database: { url: "postgresql://demo@127.0.0.1:55432/acme_demo" } } },
      env: {},
    });
    const row = checkDatabase(check);
    expect(row.status).toBe("fail");
    // The first fix names the exact overridden settings, fingerprinted.
    expect(row.fix).toMatch(/^Only if the server you capture against is started with app.database.url/);
    expect(row.fix).toContain('ignoreEnv: [".env:DATABASE_URL#');
    expect(row.fix).toContain('".env:DATABASE_URL_DIRECT#');
    // The message doesn't push throwaway for a database that may hold real data.
    expect(row.detail).not.toMatch(/app\.database\.throwaway/);
    // Any throwaway suggestion carries the disposable-copy warning.
    for (const s of check.suggestions.filter((s) => s.includes("throwaway:"))) expect(s).toMatch(/^Only if .* a disposable copy holding no real data/);
  });

  it("database: a remote app.database.url over remote env files keeps the throwaway sentence, with its warning (M36 review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-doctor-db-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgresql://acme_owner:pw@ep-acme-123456.us-east-2.aws.neon.tech/acme\n");
    const check = await checkAppDatabase({
      config: { app: { dir, database: { url: "postgresql://acme_owner:pw@ep-acme-999999.us-east-2.aws.neon.tech/acme_copy" } } },
      env: {},
    });
    // ignoreEnv can't make a remote app.database.url safe: throwaway is the only opt-in for it.
    expect(check.message).toMatch(/Only if (it is|they are) a disposable copy holding no real data, name (it|them) in aida.config: app.database.throwaway/);
    expect(check.suggestions.filter((s) => s.includes("throwaway:")).length).toBeGreaterThan(0);
  });

  it("database: a remote database with no app.database.url only suggests throwaway with the disposable-copy warning", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: "postgres://u:pw@ep-acme-1.neon.tech/db" } });
    expect(check.message).toMatch(/Only if it is a disposable copy holding no real data, name it/);
    const throwaway = check.suggestions.filter((s) => s.includes("throwaway:"));
    expect(throwaway.length).toBeGreaterThan(0);
    for (const s of throwaway) expect(s).toMatch(/^Only if this database is a disposable copy holding no real data/);
  });

  it("outbound: warns unless acknowledged", () => {
    expect(checkOutboundSenders(checkOutbound({ env: { RESEND_API_KEY: "x" } })).status).toBe("warn");
    expect(checkOutboundSenders(checkOutbound({ env: { RESEND_API_KEY: "x" }, config: { app: { outbound: "dry-run" } } })).status).toBe("ok");
    expect(checkOutboundSenders(checkOutbound({ env: {} })).status).toBe("ok");
  });

  it("help app: node_modules, aida-docs installed, and it's the aida engine", () => {
    expect(checkHelpApp(undefined).status).toBe("skip");
    expect(checkHelpApp({ dir: "/h", hasNodeModules: false })).toMatchObject({ status: "fail", fix: "cd /h && npm install" });
    expect(checkHelpApp({ dir: "/h", hasNodeModules: true }).status).toBe("fail");
    const impostor = checkHelpApp({
      dir: "/h",
      hasNodeModules: true,
      aidaPackage: { name: "aida-docs", description: "Generate docs from comments" },
      aidaPackagePath: "/root/node_modules/aida-docs/package.json",
    });
    expect(impostor.status).toBe("fail");
    expect(impostor.detail).toMatch(/aida-docs package installed in the help app isn't aida's engine; run aida init again/);
    expect(impostor.detail).toContain("/root/node_modules/aida-docs/package.json");
    // Never `npx aida`: that runs the unrelated npm package this check just caught.
    expect(impostor.fix).toBe(`${aidaCommand()} init <app-dir>`);
    expect(impostor.fix).not.toMatch(/npx aida/);
    const ours = { name: "aida-docs", description: "AIDA engine: turns walkthrough files...", bin: { aida: "dist/cli.js" }, main: "dist/index.js" };
    // The engine under its old package name doesn't count: the help app imports "aida-docs".
    expect(checkHelpApp({ dir: "/h", hasNodeModules: true, aidaPackage: { ...ours, name: "aida" }, aidaMainExists: true }).status).toBe("fail");
    const ok = checkHelpApp({ dir: "/h", hasNodeModules: true, aidaPackage: ours, aidaPackagePath: "/root/node_modules/aida-docs/package.json", aidaMainExists: true });
    expect(ok.status).toBe("ok");
    expect(ok.detail).toMatch(/aida-docs resolves.*workspace engine/);
    expect(ok.detail).toContain("/root/node_modules/aida-docs/package.json");
    expect(checkHelpApp({ dir: "/h", hasNodeModules: true, aidaPackage: ours, aidaMainExists: false }).status).toBe("fail");
    // The lean runtime build `aida init` packs has no bin, only the marker.
    const runtime = { name: "aida-docs", description: "AIDA engine, help app runtime", aidaRuntime: true, main: "dist/index.js" };
    const okRuntime = checkHelpApp({ dir: "/h", hasNodeModules: true, aidaPackage: runtime, aidaPackagePath: "/h/node_modules/aida-docs/package.json", aidaMainExists: true });
    expect(okRuntime.status).toBe("ok");
    expect(okRuntime.detail).toMatch(/lean runtime build/);
  });
});

function fakeProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: () => "22.5.0",
    platform: () => "linux",
    commandVersion: async (cmd) => `${cmd} version 8`,
    ffmpegStatic: async () => undefined,
    playwright: async () => ({ version: "1.64.1", chromiumRevision: "1248", chromiumPath: "/c", chromiumInstalled: true }),
    launchChromium: async () => ({ ok: true }),
    freeBytes: () => 40 * GB,
    dirSize: async () => undefined,
    fetchStatus: async () => ({ status: 200 }),
    helpApp: (dir) => ({ dir, hasNodeModules: true, aidaPackage: { name: "aida-docs", description: "AIDA engine", bin: {}, main: "dist/index.js" }, aidaMainExists: true }),
    ...over,
  };
}

describe("runDoctor", () => {
  it("runs only the machine checks without a config, and passes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aida-doctor-"));
    dirs.push(cwd);
    const result = await runDoctor({ cwd, probes: fakeProbes(), env: {} });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(["node", "ffmpeg", "ffprobe", "playwright", "chromium", "disk", "config"]);
    expect(result.checks.find((c) => c.id === "config")?.status).toBe("skip");
  });

  it("fails on any failed check and skips the launch when the browser isn't downloaded", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aida-doctor-"));
    dirs.push(cwd);
    let launched = false;
    const result = await runDoctor({
      cwd,
      env: {},
      probes: fakeProbes({
        playwright: async () => ({ version: "1.64.1", chromiumPath: "/c", chromiumInstalled: false }),
        launchChromium: async () => {
          launched = true;
          return { ok: true };
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(launched).toBe(false);
    expect(formatDoctor(result)).toMatch(/fix: npx playwright install chromium/);
  });

  it("with a config: checks the app, its database (refusal = fail) and the help app", async () => {
    const root = mkdtempSync(join(tmpdir(), "aida-doctor-"));
    dirs.push(root);
    const help = join(root, "help");
    mkdirSync(help);
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, ".env.local"), "DATABASE_URL=postgres://owner:Secret123@ep-x.neon.tech/neondb\n");
    writeFileSync(
      join(help, "aida.config.mjs"),
      `export default { app: { baseUrl: "http://127.0.0.1:3000" }, walkthroughsDir: "./walkthroughs", helpApp: "." };`,
    );
    const sized: string[] = [];
    const fetchTimeouts: number[] = [];
    const result = await runDoctor({
      cwd: root,
      env: {},
      probes: fakeProbes({
        dirSize: async (dir) => {
          sized.push(dir);
          return { bytes: 2 * GB, truncated: true };
        },
        fetchStatus: async (_url, timeoutMs) => {
          fetchTimeouts.push(timeoutMs);
          return { status: 200 };
        },
      }),
    });
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.config.status).toBe("ok");
    expect(byId.app.status).toBe("ok");
    expect(byId.database.status).toBe("fail");
    expect(byId["next-cache"].status).toBe("warn");
    expect(sized).toEqual([join(root, ".next")]);
    // The app may still be compiling on first request (a next dev server took 4.7 s in the
    // wild) — doctor gives it up to 20 s, not the 3 s it used to.
    expect(fetchTimeouts).toEqual([20_000]);
    expect(byId["help-app"].status).toBe("ok");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Secret123");
  });
});

describe("aidaCommand (doctor's fix text)", () => {
  it("names this checkout's CLI by path, never npx aida", () => {
    expect(aidaCommand("/opt/aida/packages/engine", false)).toBe("node /opt/aida/packages/engine/dist/cli.js");
    expect(aidaCommand("/opt/aida/packages/engine", true)).toBe("npx tsx /opt/aida/packages/engine/src/cli.ts");
    expect(aidaCommand("/my docs/aida/packages/engine", false)).toBe('node "/my docs/aida/packages/engine/dist/cli.js"');
    // Under vitest the engine runs from source: the real path to this checkout's src/cli.ts.
    expect(aidaCommand()).toBe(`npx tsx ${fileURLToPath(new URL("../../src/cli.ts", import.meta.url))}`);
    expect(checkConfig(undefined, undefined, false, "node /x/cli.js").fix).toBe("node /x/cli.js init <app-dir>");
  });
});
