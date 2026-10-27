// `aida whats-new [--since <ref>] [--from-github]` (build-plan.md M21 step 4).
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { createNodeCommandRunner } from "../publish/index.js";
import { buildWhatsNew } from "../whats-new/index.js";

export interface RunWhatsNewOptions {
  configPath: string;
  since?: string;
  fromGithub?: boolean;
  appRepo?: string;
}

/**
 * Runs `aida whats-new`. The app repo scanned for merge history is `--app-repo`, then
 * `config.impact.appRepo`, then the directory the config file lives in — never `process.cwd()`,
 * so this works the same from the app repo root or from CI with an absolute `--config` path.
 */
export async function runWhatsNew(opts: RunWhatsNewOptions, json: boolean): Promise<number> {
  let config;
  try {
    config = await loadConfig(opts.configPath);
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }

  if (!config.helpApp) {
    const message = "config.helpApp is not set — whats-new writes content/docs/whats-new/index.mdx into a help app";
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }

  const appRepo = opts.appRepo ?? config.impact?.appRepo ?? dirname(resolve(opts.configPath));

  try {
    const result = await buildWhatsNew({
      appRepo,
      helpApp: config.helpApp,
      since: opts.since,
      fromGithub: opts.fromGithub,
      runner: createNodeCommandRunner(),
    });

    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`wrote ${result.pageFile} (${result.entryCount} entr${result.entryCount === 1 ? "y" : "ies"}, ${result.skippedCount} filtered out)${result.since ? ` since ${result.since}` : ""}`);
      for (const s of result.suggestions) console.log(`note: ${s.message}`);
    }
    return 0;
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }
}
