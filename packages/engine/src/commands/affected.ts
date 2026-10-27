// `aida affected`: maps a git diff to the walkthroughs it touches (build-plan.md M17).
import { existsSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import { computeAffected } from "../impact/index.js";
import type { AffectedResult } from "../impact/index.js";

export interface RunAffectedOptions {
  configPath: string;
  /** App repo to diff; falls back to config.impact.appRepo, then cwd. */
  appRepo?: string;
  base: string;
  /** Ref to diff `base` against. Default `"HEAD"` — set with `base: "<commit>^"` to evaluate one
   * historic commit in isolation. */
  head?: string;
  app?: string;
  includeWorkingTree?: boolean;
}

/** Terse text rendering of an `AffectedResult`, for non-`--json` output. */
export function formatAffected(result: AffectedResult): string {
  const lines: string[] = [];
  lines.push(`base: ${result.base}`);
  lines.push(`head: ${result.head}`);
  lines.push(`changed files: ${result.changedFiles.length}`);
  if (result.all) lines.push(`all walkthroughs affected${result.reason ? ` — ${result.reason}` : ""}`);
  lines.push("");
  for (const wt of result.walkthroughs) {
    lines.push(`${wt.affected ? "[affected]  " : "[unchanged] "}${wt.id}`);
    for (const reason of wt.reasons) lines.push(`    ${reason}`);
  }
  return lines.join("\n");
}

/** Runs `aida affected`: prints which walkthroughs a diff touches. */
export async function runAffected(opts: RunAffectedOptions, json: boolean): Promise<number> {
  if (!existsSync(opts.configPath)) {
    const message = `no config file at ${opts.configPath}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`affected failed: ${message}`);
    return 1;
  }

  const config = await loadConfig(opts.configPath);
  const appRepo = opts.appRepo ?? config.impact?.appRepo ?? process.cwd();

  if (!existsSync(appRepo)) {
    const message = `app repo not found: ${appRepo}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`affected failed: ${message}`);
    return 1;
  }

  let result: AffectedResult;
  try {
    result = await computeAffected({
      appRepo,
      base: opts.base,
      head: opts.head,
      config,
      app: opts.app,
      includeWorkingTree: opts.includeWorkingTree,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`affected failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatAffected(result));
  }
  return 0;
}
