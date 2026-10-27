// `aida doctor`'s checks (build-plan.md M24). Each check is a pure function of what a probe
// found, so tests inject probe results instead of touching the machine; doctor/probes.ts holds
// the real probes. Every check gives ok/warn/fail and, when something needs doing, one command
// (or one plain step) that fixes it. The first outside run hit these one at a time: Node,
// ffmpeg, the Playwright browser build, missing Chromium libraries, a disk filled by a 1.7 GB
// dev-server cache.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDatabaseCheck } from "../safety/database.js";
import type { OutboundCheck } from "../safety/outbound.js";
import { AIDA_PACKAGE } from "../package-name.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  /** Short name shown in the summary, e.g. "Node.js". */
  label: string;
  status: DoctorStatus;
  /** One line: what was found. */
  detail: string;
  /** One line: the command (or step) that fixes it. */
  fix?: string;
  /** Extra structured data for `--json` (e.g. the full database check). */
  data?: unknown;
}

const GB = 1024 ** 3;

/** The engine package root: this file is `src/doctor/checks.ts` under tsx, `dist/doctor/checks.js`
 * when built. */
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * How to run this aida from anywhere: its own CLI by path. Never `npx aida`: the help app's
 * lean engine tarball has no `bin`, so npx would fetch the unrelated npm package called "aida"
 * (decisions #29); the engine's own package, `aida-docs`, isn't published yet. `fromSource` is true under tsx (dist may be missing), false from dist.
 */
export function aidaCommand(engineDir: string = ENGINE_DIR, fromSource: boolean = import.meta.url.endsWith(".ts")): string {
  const quote = (p: string) => (/[\s"'$`]/.test(p) ? JSON.stringify(p) : p);
  return fromSource ? `npx tsx ${quote(join(engineDir, "src", "cli.ts"))}` : `node ${quote(join(engineDir, "dist", "cli.js"))}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function ffmpegInstallFix(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "brew install ffmpeg";
  if (platform === "win32") return "winget install ffmpeg";
  return "sudo apt-get install -y ffmpeg";
}

/** Node 22 or later (root package.json `engines`). */
export function checkNode(version: string): DoctorCheck {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  const shown = version.startsWith("v") ? version : `v${version}`;
  if (major >= 22) return { id: "node", label: "Node.js", status: "ok", detail: shown };
  return {
    id: "node",
    label: "Node.js",
    status: "fail",
    detail: `${shown} is too old; aida needs Node 22 or later`,
    fix: "nvm install 22 && nvm use 22",
  };
}

/** ffmpeg on PATH, else the bundled ffmpeg-static binary. */
export function checkFfmpeg(system: string | undefined, staticPath: string | undefined, platform: NodeJS.Platform): DoctorCheck {
  if (system) return { id: "ffmpeg", label: "ffmpeg", status: "ok", detail: system };
  if (staticPath) return { id: "ffmpeg", label: "ffmpeg", status: "ok", detail: `bundled ffmpeg-static (${staticPath})` };
  return {
    id: "ffmpeg",
    label: "ffmpeg",
    status: "fail",
    detail: "no working ffmpeg on PATH or from ffmpeg-static; videos can't be rendered",
    fix: ffmpegInstallFix(platform),
  };
}

/** ffprobe on PATH (ffmpeg-static doesn't ship it; video checks need it). */
export function checkFfprobe(system: string | undefined, platform: NodeJS.Platform): DoctorCheck {
  if (system) return { id: "ffprobe", label: "ffprobe", status: "ok", detail: system };
  return {
    id: "ffprobe",
    label: "ffprobe",
    status: "fail",
    detail: "no ffprobe on PATH; video checks can't run",
    fix: ffmpegInstallFix(platform),
  };
}

export interface PlaywrightInfo {
  /** Installed `playwright` package version. */
  version: string;
  /** Chromium build (revision) this Playwright version expects, when known. */
  chromiumRevision?: string;
  /** Where this Playwright version expects its Chromium. */
  chromiumPath: string;
  chromiumInstalled: boolean;
}

/** Playwright installed, and the Chromium build that matches its version downloaded. */
export function checkPlaywright(info: PlaywrightInfo | undefined): DoctorCheck {
  if (!info) {
    return {
      id: "playwright",
      label: "Playwright",
      status: "fail",
      detail: "the playwright package isn't installed",
      fix: "npm install playwright",
    };
  }
  const build = info.chromiumRevision ? `Chromium build ${info.chromiumRevision}` : "its Chromium build";
  if (!info.chromiumInstalled) {
    return {
      id: "playwright",
      label: "Playwright",
      status: "fail",
      detail: `playwright ${info.version} needs ${build}, which isn't downloaded (expected at ${info.chromiumPath})`,
      fix: "npx playwright install chromium",
    };
  }
  return { id: "playwright", label: "Playwright", status: "ok", detail: `playwright ${info.version}, ${build} installed` };
}

export type LaunchResult = { ok: true } | { ok: false; error: string };

/**
 * Chromium actually starts. A missing system library shows up as "error while loading shared
 * libraries: libX.so"; Playwright's own check says "Host system is missing dependencies".
 */
export function checkChromiumLaunch(result: LaunchResult | undefined): DoctorCheck {
  if (!result) {
    return { id: "chromium", label: "Chromium launch", status: "skip", detail: "skipped: Playwright or its Chromium isn't installed" };
  }
  if (result.ok) return { id: "chromium", label: "Chromium launch", status: "ok", detail: "starts headless" };
  const lib = /error while loading shared libraries: ([^\s:]+)/.exec(result.error)?.[1];
  if (lib) {
    return {
      id: "chromium",
      label: "Chromium launch",
      status: "fail",
      detail: `Chromium can't start: the system library ${lib} is missing`,
      fix: "sudo npx playwright install-deps chromium",
    };
  }
  if (/missing dependencies|install-deps/i.test(result.error)) {
    return {
      id: "chromium",
      label: "Chromium launch",
      status: "fail",
      detail: "Chromium can't start: system libraries are missing",
      fix: "sudo npx playwright install-deps chromium",
    };
  }
  if (/Executable doesn't exist|playwright install/i.test(result.error)) {
    return {
      id: "chromium",
      label: "Chromium launch",
      status: "fail",
      detail: "Chromium isn't downloaded for this Playwright version",
      fix: "npx playwright install chromium",
    };
  }
  return {
    id: "chromium",
    label: "Chromium launch",
    status: "fail",
    detail: `Chromium can't start: ${result.error.split("\n")[0]}`,
    fix: "npx playwright install --with-deps chromium",
  };
}

/** Free space where build output goes: warn under 5 GB, fail under 1 GB. */
export function checkDisk(dir: string, freeBytes: number | undefined): DoctorCheck {
  if (freeBytes === undefined) {
    return { id: "disk", label: "Disk space", status: "warn", detail: `couldn't read free space for ${dir}` };
  }
  const detail = `${formatBytes(freeBytes)} free for ${dir}`;
  const fix = "free some space (e.g. delete old .build/ folders and the app's .next/cache)";
  if (freeBytes < 1 * GB) return { id: "disk", label: "Disk space", status: "fail", detail: `${detail}; capture and render need at least 1 GB`, fix };
  if (freeBytes < 5 * GB) return { id: "disk", label: "Disk space", status: "warn", detail: `${detail}; under 5 GB, a full build may run out`, fix };
  return { id: "disk", label: "Disk space", status: "ok", detail };
}

/** The app's `.next` folder: over 1 GB is usually a `next dev` cache that keeps growing. */
export function checkNextCache(appDir: string | undefined, size: { bytes: number; truncated: boolean } | undefined): DoctorCheck {
  if (!appDir) return { id: "next-cache", label: "App .next cache", status: "skip", detail: "skipped: no app directory (set app.dir in aida.config)" };
  const dir = join(appDir, ".next");
  if (!size) return { id: "next-cache", label: "App .next cache", status: "ok", detail: `no ${dir}` };
  const shown = `${size.truncated ? "over " : ""}${formatBytes(size.bytes)}`;
  if (size.bytes > GB) {
    return {
      id: "next-cache",
      label: "App .next cache",
      status: "warn",
      detail: `${dir} is ${shown}; the \`next dev\` cache grows during capture. Capture against \`next build && next start\` instead`,
      fix: `rm -rf ${join(dir, "cache")}`,
    };
  }
  return { id: "next-cache", label: "App .next cache", status: "ok", detail: `${dir} is ${shown}` };
}

/** aida.config loads. `error` is the load error's message; `path` undefined means none found. */
export function checkConfig(path: string | undefined, error: string | undefined, explicit: boolean, aida: string = aidaCommand()): DoctorCheck {
  if (!path) {
    return {
      id: "config",
      label: "aida config",
      status: explicit ? "fail" : "skip",
      detail: explicit ? "config file not found" : "no aida.config found here or in ./help; only machine checks ran",
      fix: explicit ? undefined : `${aida} init <app-dir>`,
    };
  }
  if (error) {
    return { id: "config", label: "aida config", status: "fail", detail: `${path} doesn't load: ${error.split("\n")[0]}`, fix: `fix ${path}` };
  }
  return { id: "config", label: "aida config", status: "ok", detail: path };
}

export type FetchResult = { status: number } | { error: string };

/** How long `aida doctor` waits for the app to answer. A `next dev` server compiles the first
 * page on request — observed 4.7 s for a simple page — so this needs headroom beyond that. A
 * connection refused (app not started) rejects immediately regardless of this budget. */
export const APP_REACHABLE_TIMEOUT_MS = 20_000;

/** The app answers at `baseUrl` (any HTTP response, even 3xx/4xx/5xx, counts). Unreachable is a
 * warning: the app may simply not be started yet, or (for a dev server) still be compiling. */
export function checkBaseUrl(baseUrl: string, result: FetchResult): DoctorCheck {
  if ("status" in result) return { id: "app", label: "App reachable", status: "ok", detail: `${baseUrl} answered ${result.status}` };
  const fix = "start the app (`npm run build && npm run start`) so it answers at app.baseUrl";
  if (result.error === "TimeoutError") {
    return {
      id: "app",
      label: "App reachable",
      status: "warn",
      detail: `${baseUrl} didn't answer within ${APP_REACHABLE_TIMEOUT_MS / 1000} s (a dev server may still be compiling; try again, or capture against \`next build && next start\`)`,
      fix,
    };
  }
  return {
    id: "app",
    label: "App reachable",
    status: "warn",
    detail: `${baseUrl} didn't answer (${result.error}); capture needs the app running`,
    fix,
  };
}

/** The app's database: remote or unreadable fails (capture will refuse), unknown warns. */
export function checkDatabase(check: AppDatabaseCheck): DoctorCheck {
  const extra = check.warnings.length > 0 ? ` ${check.warnings.join(" ")}` : "";
  const base = { id: "database", label: "App database", data: check };
  if (check.refuse) {
    return { ...base, status: "fail", detail: `capture will refuse. ${check.message}`, fix: check.suggestions[0] };
  }
  if (check.status === "unknown") return { ...base, status: "warn", detail: `${check.message}${extra}`, fix: check.suggestions[0] };
  return { ...base, status: check.warnings.length > 0 ? "warn" : "ok", detail: `${check.message}${extra}` };
}

/** Live email/SMS senders: a warning unless acknowledged. A live payment key not in
 * app.allowLivePayments fails (capture will refuse). */
export function checkOutboundSenders(check: OutboundCheck): DoctorCheck {
  const base = { id: "outbound", label: "Emails, texts, payments", data: check };
  if (check.findings.length === 0) return { ...base, status: "ok", detail: "no live senders or payment keys found" };
  if (check.refusal) return { ...base, status: "fail", detail: `capture will refuse. ${check.refusal}`, fix: check.refusalSuggestions[0] };
  if (check.acknowledged) {
    return { ...base, status: "ok", detail: `${check.findings.length} sender setting(s) found; app.outbound is "dry-run"` };
  }
  return { ...base, status: "warn", detail: check.message, fix: 'set the app to dry-run, then add app: { outbound: "dry-run" } to aida.config' };
}

export interface HelpAppInfo {
  dir: string;
  hasNodeModules: boolean;
  /** Where `aida-docs/package.json` resolved from, via real Node resolution starting at `dir`
   * (createRequire, which walks up through hoisted/workspace `node_modules` the same way the
   * help app's own imports would) — not just `<dir>/node_modules/aida-docs`. */
  aidaPackagePath?: string;
  /** `aidaRuntime` marks the lean help-app build `aida init` packs (no `bin`: the CLI runs from
   * the aida checkout or package, not from the help app). */
  aidaPackage?: { name?: string; description?: string; bin?: unknown; main?: string; aidaRuntime?: unknown };
  /** The resolved package's `main` file exists. */
  aidaMainExists?: boolean;
}

/** The help app has its dependencies, and `aida-docs` inside it is this engine (decisions #29: a
 * bare registry name once resolved to an unrelated package called "aida", the engine's old name),
 * resolved the way Node would actually resolve it (hoisted/workspace `node_modules` included), not
 * just a direct `<dir>/node_modules/aida-docs` path. */
export function checkHelpApp(info: HelpAppInfo | undefined, aida: string = aidaCommand()): DoctorCheck {
  const label = "Help app";
  if (!info) return { id: "help-app", label, status: "skip", detail: "skipped: no helpApp in aida.config" };
  const install = `cd ${info.dir} && npm install`;
  if (!info.hasNodeModules) {
    return { id: "help-app", label, status: "fail", detail: `${info.dir} has no node_modules`, fix: install };
  }
  const pkg = info.aidaPackage;
  if (!pkg) return { id: "help-app", label, status: "fail", detail: `${AIDA_PACKAGE} isn't installed in the help app`, fix: install };
  const ours = pkg.name === AIDA_PACKAGE && (Boolean(pkg.bin) || pkg.aidaRuntime === true) && /^aida engine\b/i.test(pkg.description ?? "");
  if (!ours) {
    return {
      id: "help-app",
      label,
      status: "fail",
      detail: `the ${AIDA_PACKAGE} package installed in the help app isn't aida's engine; run aida init again${info.aidaPackagePath ? ` (resolved ${info.aidaPackagePath})` : ""}`,
      fix: `${aida} init <app-dir>`,
    };
  }
  if (info.aidaMainExists === false) {
    return { id: "help-app", label, status: "fail", detail: `${AIDA_PACKAGE} in the help app isn't built (its dist/ is missing)`, fix: install };
  }
  const kind = pkg.aidaRuntime === true ? "lean runtime build" : "workspace engine";
  const from = info.aidaPackagePath ? ` from ${info.aidaPackagePath}` : "";
  return { id: "help-app", label, status: "ok", detail: `${info.dir}: ${AIDA_PACKAGE} resolves${from} (${kind})` };
}
