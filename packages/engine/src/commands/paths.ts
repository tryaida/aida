// `aida paths <id>`: other screens the walkthrough's task can start from (decision 34;
// src/paths/discover.ts). Agent-facing: a short list of candidate pages, each with the call site
// that makes the same save as the main path, for the writer to inspect before adding a `paths:`
// entry.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { findWalkthrough } from "../outline/record.js";
import { discoverPaths, formatDiscoverPaths } from "../paths/index.js";

export interface RunPathsOptions {
  configPath: string;
  walkthrough: string;
  /** App repo to read; falls back to config.impact.appRepo, then cwd. */
  appRepo?: string;
  app?: string;
  limit?: number;
}

export async function runPaths(opts: RunPathsOptions, json: boolean): Promise<number> {
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`paths failed: ${message}`);
    return 1;
  };
  if (!existsSync(opts.configPath)) return fail(`no config file at ${opts.configPath}`);
  try {
    const config = await loadConfig(opts.configPath);
    const walkthrough = findWalkthrough(config.walkthroughsDir, opts.walkthrough);
    if (!walkthrough) return fail(`no walkthrough "${opts.walkthrough}" in ${config.walkthroughsDir}`);
    const appRepo = opts.appRepo ?? config.impact?.appRepo ?? process.cwd();
    if (!existsSync(appRepo)) return fail(`app repo not found: ${appRepo}`);
    const result = discoverPaths({
      walkthrough,
      captureDir: join(config.buildDir, walkthrough.walkthrough, "capture"),
      appRepo,
      app: opts.app ?? config.impact?.app,
      limit: opts.limit,
    });
    console.log(json ? JSON.stringify(result) : formatDiscoverPaths(result));
    return 0;
  } catch (err) {
    return fail(((err as Error).message ?? String(err)).split("\n")[0]);
  }
}
