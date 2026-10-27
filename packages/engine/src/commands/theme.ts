// `aida theme [dir] [--config <path>] [--detect] [--app-repo <path>] [--json]` — rewrites the
// help app's generated theme files (app/brand.css, lib/brand.json, public/brand/*) from
// aida.config's `brand` (src/theme/write.ts). `--detect` re-runs brand detection against the
// app repo and prints a suggested `brand: { ... }` block instead — aida never rewrites a
// user's config file (same rule as `aida init`), so paste it in by hand.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import type { BrandConfig } from "../config/types.js";
import { extractBrand, rebaseBrandPaths } from "../init/brand.js";
import { formatBrandBlock } from "../init/write-config.js";
import { writeHelpAppTheme, type WriteThemeResult } from "../theme/write.js";

export interface ThemeOptions {
  /** Help-app directory (or a repo with `help/aida.config.*`). Default cwd. */
  dir?: string;
  /** Explicit config path; overrides `dir` discovery. */
  config?: string;
  /** Print a suggested brand block detected from the app instead of writing files. */
  detect?: boolean;
  /** App repo to detect from (with `detect`). Default: config.impact.appRepo, else the config dir. */
  appRepo?: string;
}

export type ThemeResult =
  | { mode: "write"; configFile: string; helpAppDir: string; result: WriteThemeResult }
  | { mode: "detect"; configFile?: string; appRepoDir: string; brand: BrandConfig; block: string; current?: BrandConfig };

const CONFIG_NAMES = ["aida.config.ts", "aida.config.mts", "aida.config.mjs", "aida.config.js"];

/** `<dir>/aida.config.*`, else `<dir>/help/aida.config.*` (the `aida init` layout). */
export function findConfigFile(dir: string): string | undefined {
  for (const base of [dir, join(dir, "help")]) {
    for (const name of CONFIG_NAMES) {
      const file = join(base, name);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

export async function runThemeCommand(options: ThemeOptions): Promise<ThemeResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const configFile = options.config ? resolve(options.config) : findConfigFile(dir);

  if (options.detect) {
    const config = configFile ? await loadConfig(configFile) : undefined;
    const configDir = configFile ? dirname(configFile) : dir;
    const appRepoDir = resolve(options.appRepo ?? config?.impact?.appRepo ?? configDir);
    const brand = rebaseBrandPaths(extractBrand(appRepoDir), appRepoDir, configDir);
    return { mode: "detect", configFile, appRepoDir, brand, block: formatBrandBlock(brand), current: config?.brand };
  }

  if (!configFile) {
    throw new Error(`no aida.config.* in ${dir} (or ${join(dir, "help")}) — pass --config <path>`);
  }
  const config = await loadConfig(configFile);
  const helpAppDir = config.helpApp ?? config.configDir;
  const result = writeHelpAppTheme(config, helpAppDir);
  return { mode: "write", configFile, helpAppDir, result };
}

export async function runTheme(options: ThemeOptions, json: boolean): Promise<number> {
  let out: ThemeResult;
  try {
    out = await runThemeCommand(options);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(`error: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(out));
    return 0;
  }

  if (out.mode === "detect") {
    console.log(`brand detected from ${out.appRepoDir}:`);
    if (!out.block) {
      console.log("  (nothing detected — the help app keeps its default theme)");
      return 0;
    }
    console.log("");
    console.log(out.block.trimEnd());
    console.log("");
    console.log(
      out.configFile
        ? `paste this over the brand block in ${out.configFile}, then run \`aida theme\` (aida never edits your config).`
        : "paste this into your aida.config.ts, then run `aida theme`.",
    );
    return 0;
  }

  const { result } = out;
  console.log(`theme for ${out.helpAppDir} (from ${out.configFile})`);
  if (result.written.length === 0 && result.removed.length === 0) {
    console.log("  up to date — nothing changed");
  }
  for (const f of result.written) console.log(`  wrote ${f}`);
  for (const f of result.removed) console.log(`  removed ${f}`);
  for (const w of result.warnings) console.log(`  warning: ${w}`);
  return 0;
}
