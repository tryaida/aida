import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import { buildPage, type BuildPageResult } from "../pages/index.js";
import { captureDirFor, devicesFor } from "../devices/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";

export interface RunPagesOptions {
  configPath: string;
  videoDir?: string;
  outDir?: string;
}

/** Resolves a walkthrough argument (a path, or a bare id/slug) to its YAML file. */
function resolveWalkthroughFile(walkthroughsDir: string, arg: string): string {
  if (existsSync(arg)) return arg;
  const candidates = readdirSync(walkthroughsDir).filter((f) => /\.(ya?ml)$/i.test(f));
  const match = candidates.find((f) => f === `${arg}.yaml` || f === `${arg}.yml`);
  if (!match) throw new Error(`no walkthrough found for "${arg}" in ${walkthroughsDir}`);
  return join(walkthroughsDir, match);
}

/** Runs `aida pages`: builds one walkthrough's help page + screenshots from its capture. */
export async function runPages(walkthroughArg: string, opts: RunPagesOptions, json: boolean): Promise<number> {
  const config = await loadConfig(opts.configPath);
  const file = resolveWalkthroughFile(config.walkthroughsDir, walkthroughArg);
  const wf = loadWalkthroughFile(file);

  // Every device this walkthrough is shown on (decision 40, M43b), primary first — same
  // resolution `aida build` uses, so `aida pages` (this command, for one walkthrough at a time)
  // reads the primary's capture from the right directory and picks up any phone capture too.
  const devices = devicesFor(wf, config, loadBrief(briefPath(config)));
  const captureDir = captureDirFor(config.buildDir, wf.walkthrough, devices[0]);
  const outDir = opts.outDir ?? join(config.outDir, "pages");
  const videoDir = opts.videoDir ?? join(config.outDir, "videos");
  const secondaryCaptures = devices.slice(1).map((device) => ({ device, captureDir: captureDirFor(config.buildDir, wf.walkthrough, device) }));

  let result: BuildPageResult;
  try {
    result = await buildPage(wf, captureDir, outDir, { videoDir, readers: config.readers, roles: config.roles, devices, secondaryCaptures });
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, walkthrough: wf.walkthrough, error: message }));
    else console.error(`pages failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
  } else {
    const status = result.publishable ? "PUBLISHABLE" : "NOT PUBLISHABLE";
    console.log(`${result.id}: ${status} -> ${result.indexFile}`);
    console.log(`  ${result.screenshots.length} screenshot(s) in ${result.screenshotsDir}`);
    if (result.lastChecked) console.log(`  last checked: ${result.lastChecked}`);
    for (const p of result.problems) console.log(`  problem: ${p}`);
    for (const s of result.suggestions) console.log(`  suggestion [${s.key}]: ${s.message}`);
  }
  return result.publishable ? 0 : 1;
}
