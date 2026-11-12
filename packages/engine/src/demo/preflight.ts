// The machine checks `aida demo` runs before it writes or starts anything: the doctor checks the
// demo's stages need (doctor/checks.ts), so a missing browser or ffmpeg stops it at the start
// with the one command that fixes it, instead of halfway through a capture or a render.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { aidaInvocation, shellWord } from "./invocation.js";
import {
  checkChromiumLaunch,
  checkDisk,
  checkFfmpeg,
  checkFfprobe,
  checkNode,
  checkPlaywright,
  formatBytes,
  realProbes,
  type DoctorCheck,
  type DoctorProbes,
} from "../doctor/index.js";

const GB = 1024 ** 3;

export interface PreflightOptions {
  /** The demo folder (free space is read where it will be). */
  dir: string;
  /** Narrated videos asked for: ffmpeg and ffprobe are needed. */
  video: boolean;
  /** The help site asked for: npm and room for its install. */
  site: boolean;
  probes?: DoctorProbes;
}

/** Room the help site's `npm install` takes, plus the build itself. */
const SITE_INSTALL_BYTES = 1.5 * GB;

export async function runPreflight(opts: PreflightOptions): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const probes = opts.probes ?? realProbes;
  const platform = probes.platform();
  const [ffmpeg, ffprobe, ffmpegStatic, playwright, npm] = await Promise.all([
    opts.video ? probes.commandVersion("ffmpeg") : Promise.resolve(undefined),
    opts.video ? probes.commandVersion("ffprobe") : Promise.resolve(undefined),
    opts.video ? probes.ffmpegStatic() : Promise.resolve(undefined),
    probes.playwright(),
    opts.site ? probes.commandVersion("npm") : Promise.resolve(undefined),
  ]);
  const launch = playwright?.chromiumInstalled ? await probes.launchChromium() : undefined;
  const free = probes.freeBytes(opts.dir);

  const launchCheck = checkChromiumLaunch(launch);
  // A launch that only ran out of time says the machine is busy, not that Chromium is broken:
  // capture waits longer, and fails with its own message if it really can't start.
  if (launch && !launch.ok && /timeout \d+\s*ms exceeded/i.test(launch.error)) {
    Object.assign(launchCheck, { status: "warn", detail: "Chromium was slow to start (a busy machine?); going ahead", fix: undefined });
  }
  const checks: DoctorCheck[] = [checkNode(probes.nodeVersion()), checkPlaywright(playwright), launchCheck];
  if (opts.video) {
    checks.push(checkFfmpeg(ffmpeg, ffmpegStatic, platform), checkFfprobe(ffprobe, platform));
    // The fix for either is the same package; a demo without videos needs neither.
    for (const c of checks.slice(-2)) if (c.status === "fail") c.fix = `${c.fix}, or run ${aidaInvocation()} demo --no-video`;
  }
  // The doctor's fixes say `npx playwright`, which can fetch another Playwright than aida's own,
  // and that one downloads a Chromium build aida's Playwright doesn't use.
  const cli = playwrightCli();
  for (const c of checks) if (c.fix) c.fix = withOwnPlaywright(c.fix, cli);
  checks.push(checkDisk(opts.dir, free));
  if (opts.site) {
    checks.push(
      npm
        ? { id: "npm", label: "npm", status: "ok", detail: `npm ${npm}` }
        : { id: "npm", label: "npm", status: "fail", detail: "npm isn't on PATH; the help site is installed with it", fix: "install Node.js with npm (https://nodejs.org), or leave out --site" },
    );
    if (free !== undefined && free < SITE_INSTALL_BYTES) {
      checks.push({
        id: "site-disk",
        label: "Room for the help site",
        status: "fail",
        detail: `${formatBytes(free)} free; the help site's install needs about ${formatBytes(SITE_INSTALL_BYTES)}`,
        fix: "free some space, or leave out --site",
      });
    }
  }
  // Only the checks that found something to fix stop the demo; warnings are shown and it goes on.
  return { ok: !checks.some((c) => c.status === "fail" || c.status === "skip"), checks };
}

/** aida's own Playwright CLI (`playwright/cli.js` of the playwright package this engine
 * resolves), or undefined when it can't be found. */
export function playwrightCli(): string | undefined {
  try {
    // cli.js isn't in the package's exports; package.json is.
    const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
    return existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/** `fix` with `npx playwright` swapped for `node <cli>` (under sudo, this Node by its full path,
 * which root's PATH may not have). Unchanged when `cli` is unknown. */
export function withOwnPlaywright(fix: string, cli: string | undefined, node: string = process.execPath): string {
  if (!cli) return fix;
  return fix
    .replace(/\bsudo npx playwright\b/g, `sudo ${shellWord(node)} ${shellWord(cli)}`)
    .replace(/\bnpx playwright\b/g, `node ${shellWord(cli)}`);
}

/**
 * True when the default voice (Kokoro) model is already downloaded, false when the first
 * narration will download it, undefined when that can't be told. It's kept in the transformers
 * package's own cache folder.
 */
export function voiceModelCached(): boolean | undefined {
  try {
    // The package doesn't export its package.json: find its folder from the main entry.
    let dir = dirname(createRequire(import.meta.url).resolve("@huggingface/transformers"));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    return existsSync(join(dir, ".cache", "onnx-community", "Kokoro-82M-v1.0-ONNX"));
  } catch {
    return undefined;
  }
}
