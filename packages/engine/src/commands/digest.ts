import { existsSync } from "node:fs";
import { buildDigest, formatDigest } from "../digest/index.js";

export interface RunDigestOptions {
  appRepo: string;
  area?: string;
  /** Explicit app directory within a workspace monorepo (relative to appRepo, or absolute). */
  app?: string;
}

/** Runs `aida digest`: prints a compact map of a target app repo's routes, roles and labels. */
export function runDigest(opts: RunDigestOptions, json: boolean): number {
  if (!existsSync(opts.appRepo)) {
    const message = `app repo not found: ${opts.appRepo}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`digest failed: ${message}`);
    return 1;
  }

  const result = buildDigest(opts.appRepo, { area: opts.area, app: opts.app });

  if (result.apps && result.apps.length > 1) {
    // Ambiguous monorepo: several Next.js apps found and no --app was given to pick one.
    if (json) console.log(JSON.stringify({ ok: false, error: result.message, apps: result.apps }));
    else console.error(`digest failed: ${result.message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatDigest(result));
  }
  return 0;
}
