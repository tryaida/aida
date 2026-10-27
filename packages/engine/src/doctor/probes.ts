// The real machine probes behind `aida doctor` (doctor/checks.ts holds the pure checks). Each
// probe is bounded in time so the whole doctor run stays under ~10 s.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FetchResult, HelpAppInfo, LaunchResult, PlaywrightInfo } from "./checks.js";

export interface DoctorProbes {
  nodeVersion(): string;
  platform(): NodeJS.Platform;
  /** First line of `<cmd> -version`, or undefined when it doesn't run. */
  commandVersion(cmd: string): Promise<string | undefined>;
  /** The ffmpeg-static binary path, when it's installed and runs. */
  ffmpegStatic(): Promise<string | undefined>;
  playwright(): Promise<PlaywrightInfo | undefined>;
  launchChromium(): Promise<LaunchResult>;
  /** Free bytes on the filesystem holding `dir` (or its nearest existing parent). */
  freeBytes(dir: string): number | undefined;
  /** Total size of `dir`, stopping early past `stopAfter` bytes; undefined when it doesn't exist. */
  dirSize(dir: string, stopAfter: number): Promise<{ bytes: number; truncated: boolean } | undefined>;
  fetchStatus(url: string, timeoutMs: number): Promise<FetchResult>;
  helpApp(dir: string): HelpAppInfo;
}

const require = createRequire(import.meta.url);

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) resolve(undefined);
      else resolve(stdout.split("\n")[0]?.trim() || cmd);
    });
  });
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Walks `dir` adding file sizes; stops past `stopAfter` bytes, 3 s or 300k entries. */
async function walkSize(dir: string, stopAfter: number): Promise<{ bytes: number; truncated: boolean } | undefined> {
  if (!existsSync(dir)) return undefined;
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  let lastYield = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (bytes > stopAfter || entries > 300_000 || Date.now() - started > 3000) return { bytes, truncated: true };
    const current = stack.pop()!;
    // Let a parallel probe (Chromium launch, the app fetch) make progress on big trees.
    if (entries - lastYield >= 2000) {
      lastYield = entries;
      await new Promise((r) => setImmediate(r));
    }
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current, name);
      entries++;
      try {
        const st = lstatSync(path);
        if (st.isDirectory()) stack.push(path);
        else bytes += st.size;
      } catch {
        // vanished or unreadable
      }
    }
  }
  return { bytes, truncated: false };
}

export const realProbes: DoctorProbes = {
  nodeVersion: () => process.versions.node,
  platform: () => process.platform,
  commandVersion: (cmd) => run(cmd, ["-version"], 5000),
  async ffmpegStatic() {
    try {
      const mod = (await import("ffmpeg-static")) as { default?: unknown };
      const path = typeof mod.default === "string" ? mod.default : undefined;
      if (!path || !existsSync(path)) return undefined;
      return (await run(path, ["-version"], 5000)) ? path : undefined;
    } catch {
      return undefined;
    }
  },
  async playwright() {
    let version: string;
    try {
      version = String(readJson(require.resolve("playwright/package.json"))?.version ?? "unknown");
    } catch {
      return undefined;
    }
    let chromiumRevision: string | undefined;
    try {
      const corePkg = require.resolve("playwright-core/package.json");
      const browsers = readJson(join(dirname(corePkg), "browsers.json")) as { browsers?: { name: string; revision: string }[] } | undefined;
      chromiumRevision = browsers?.browsers?.find((b) => b.name === "chromium")?.revision;
    } catch {
      // revision is a nicety for the message
    }
    try {
      const { chromium } = await import("playwright");
      const chromiumPath = chromium.executablePath();
      return { version, chromiumRevision, chromiumPath, chromiumInstalled: existsSync(chromiumPath) };
    } catch {
      return undefined;
    }
  },
  async launchChromium() {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ timeout: 8000 });
      await browser.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  freeBytes(dir) {
    let current = dir;
    while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
    try {
      const st = statfsSync(current);
      return st.bavail * st.bsize;
    } catch {
      return undefined;
    }
  },
  dirSize: walkSize,
  async fetchStatus(url, timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status };
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      return { error: cause ?? (err instanceof Error ? err.name : String(err)) };
    }
  },
  helpApp(dir) {
    // Real Node resolution from the help app's own directory, not a direct
    // `<dir>/node_modules/aida` path: a monorepo workspace link (or any hoisting npm/pnpm/yarn
    // does) puts `aida` in an ancestor's `node_modules`, which this walks up to find exactly
    // like the help app's own `import "aida"` would.
    let pkgPath: string | undefined;
    try {
      pkgPath = createRequire(join(dir, "package.json")).resolve("aida/package.json");
    } catch {
      pkgPath = undefined;
    }
    const pkg = pkgPath ? (readJson(pkgPath) as HelpAppInfo["aidaPackage"] | undefined) : undefined;
    const main = pkg?.main && pkgPath ? join(dirname(pkgPath), pkg.main) : undefined;
    return {
      dir,
      hasNodeModules: existsSync(join(dir, "node_modules")),
      aidaPackagePath: pkgPath,
      aidaPackage: pkg,
      aidaMainExists: main ? existsSync(main) : undefined,
    };
  },
};
