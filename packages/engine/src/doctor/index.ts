// `aida doctor` (build-plan.md M24): checks the machine and the app before a first capture, so
// setup problems show up together with their fixes instead of one failed run at a time. Machine
// checks always run; config, app, database and help-app checks run when an aida.config is found.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { checkAppDatabase, resolveAppDir } from "../safety/database.js";
import { checkOutbound } from "../safety/outbound.js";
import {
  checkBaseUrl,
  checkChromiumLaunch,
  checkConfig,
  checkDatabase,
  checkDisk,
  checkFfmpeg,
  checkFfprobe,
  checkHelpApp,
  checkNextCache,
  checkNode,
  checkOutboundSenders,
  checkPlaywright,
  APP_REACHABLE_TIMEOUT_MS,
} from "./checks.js";
import type { DoctorCheck } from "./checks.js";
import { realProbes } from "./probes.js";
import type { DoctorProbes } from "./probes.js";

export * from "./checks.js";
export { realProbes } from "./probes.js";
export type { DoctorProbes } from "./probes.js";

export interface RunDoctorOptions {
  /** `--config`. Unset: `aida.config.*` in `cwd`, then in `cwd/help`. */
  configPath?: string;
  cwd?: string;
  /** Injected in tests. */
  probes?: DoctorProbes;
  env?: Record<string, string | undefined>;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

const CONFIG_NAMES = ["aida.config.ts", "aida.config.mts", "aida.config.mjs", "aida.config.js"];

/** `<cwd>/aida.config.*`, else `<cwd>/help/aida.config.*` (the `aida init` layout). */
export function findConfig(cwd: string): string | undefined {
  for (const dir of [cwd, join(cwd, "help")]) {
    for (const name of CONFIG_NAMES) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const GB = 1024 ** 3;

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorResult> {
  const probes = opts.probes ?? realProbes;
  const cwd = opts.cwd ?? process.cwd();
  const platform = probes.platform();

  // Config first: the disk and cache checks look where it says.
  const configPath = opts.configPath ? resolve(cwd, opts.configPath) : findConfig(cwd);
  let config: ResolvedConfig | undefined;
  let configError: string | undefined;
  if (configPath && existsSync(configPath)) {
    try {
      config = await loadConfig(configPath);
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }
  const configCheck = checkConfig(configPath && existsSync(configPath) ? configPath : undefined, configError, Boolean(opts.configPath));

  const appDir = config ? resolveAppDir(config)?.dir : undefined;
  const buildDir = config?.buildDir ?? join(cwd, ".build");

  // The slow probes run side by side: Chromium launch, the app fetch, the .next walk.
  const [ffmpeg, ffprobe, ffmpegStatic, playwright] = await Promise.all([
    probes.commandVersion("ffmpeg"),
    probes.commandVersion("ffprobe"),
    probes.ffmpegStatic(),
    probes.playwright(),
  ]);
  const canLaunch = Boolean(playwright?.chromiumInstalled);
  const [launch, nextSize, fetched] = await Promise.all([
    canLaunch ? probes.launchChromium() : Promise.resolve(undefined),
    appDir ? probes.dirSize(join(appDir, ".next"), GB) : Promise.resolve(undefined),
    config ? probes.fetchStatus(config.app.baseUrl, APP_REACHABLE_TIMEOUT_MS) : Promise.resolve(undefined),
  ]);

  const checks: DoctorCheck[] = [
    checkNode(probes.nodeVersion()),
    checkFfmpeg(ffmpeg, ffmpegStatic, platform),
    checkFfprobe(ffprobe, platform),
    checkPlaywright(playwright),
    checkChromiumLaunch(launch),
    checkDisk(buildDir, probes.freeBytes(buildDir)),
    configCheck,
  ];

  if (config) {
    checks.push(checkNextCache(appDir, nextSize));
    if (fetched) checks.push(checkBaseUrl(config.app.baseUrl, fetched));
    try {
      checks.push(checkDatabase(await checkAppDatabase({ config, env: opts.env })));
    } catch (err) {
      checks.push({
        id: "database",
        label: "App database",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    checks.push(checkOutboundSenders(checkOutbound({ config, env: opts.env })));
    checks.push(checkHelpApp(config.helpApp ? probes.helpApp(config.helpApp) : undefined));
  }

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

/** Human summary: one line per check, its fix indented under it. */
export function formatDoctor(result: DoctorResult): string {
  const lines = ["aida doctor"];
  for (const c of result.checks) {
    lines.push(`  ${c.status.padEnd(4)}  ${c.label.padEnd(24)} ${c.detail}`);
    if (c.fix && (c.status === "fail" || c.status === "warn")) lines.push(`        ${"".padEnd(24)} fix: ${c.fix}`);
  }
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const warned = result.checks.filter((c) => c.status === "warn").length;
  lines.push(
    failed === 0 && warned === 0
      ? "All checks passed."
      : `${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}
