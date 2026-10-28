// `aida theme [dir] [--config <path>] [--detect] [--from-app] [--app-repo <path>] [--json]` — rewrites the
// help app's generated theme files (app/brand.css, lib/brand.json, public/brand/*) from
// aida.config's `brand` (src/theme/write.ts). `--detect` re-runs brand detection against the
// app repo and prints a suggested `brand: { ... }` block instead — aida never rewrites a
// user's config file (same rule as `aida init`), so paste it in by hand. `--from-app` (M34) reads
// the brand from the running app instead, read-only and signed in like `aida inspect`, saves it in
// `brand/from-app.json` beside the config (merged under `config.brand`: explicit values win) and
// rewrites the theme files, so the site, Studio, videos and PDFs all pick it up.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import type { BrandConfig, ResolvedConfig } from "../config/types.js";
import { isSignInPath } from "../capture/index.js";
import { captureSafetyRefusal } from "../safety/index.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import { detectedReplaces, writeAppBrand, withAppBrand, type MergeField } from "../theme/app-brand.js";
import { readBrandFromApp } from "../theme/from-app.js";
import { readBrandNotes, resolveBrandStyle, type ResolvedStyle } from "../theme/style.js";
import { configRoles, resolvePersona, storageStateKey } from "./inspect.js";
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
  /** Read the brand from the running app (signed in, read-only) and save it beside the config. */
  fromApp?: boolean;
  /** Pages to open with `fromApp` (default: the walkthroughs' start pages, at most two, else `/`). */
  pages?: string[];
  /** Persona role to sign in as with `fromApp` (like `aida inspect --as`). */
  as?: string;
}

export type ThemeResult =
  | { mode: "write"; configFile: string; helpAppDir: string; result: WriteThemeResult }
  | {
      mode: "from-app";
      configFile: string;
      helpAppDir: string;
      result: WriteThemeResult;
      /** `brand/from-app.json`. */
      saved: string;
      pages: string[];
      read: BrandConfig;
      notes: string[];
      /** Fields the outputs now take from the running app (the rest: config or repo). */
      fromApp: MergeField[];
      style: ResolvedStyle;
    }
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
  if (options.fromApp) return themeFromApp(config, configFile, options);
  const helpAppDir = config.helpApp ?? config.configDir;
  const result = writeHelpAppTheme(config, helpAppDir);
  return { mode: "write", configFile, helpAppDir, result };
}

/** The app's own repo, for telling repo-detected config values from typed ones: `--app-repo`,
 * `app.dir`, `impact.appRepo`, else the config dir's parent when it's a package (the `aida init`
 * layout, `<app>/help/aida.config.ts`). */
function appRepoFor(config: ResolvedConfig, explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  if (config.app.dir) return resolve(config.configDir, config.app.dir);
  if (config.impact?.appRepo) return resolve(config.configDir, config.impact.appRepo);
  const parent = dirname(config.configDir);
  return existsSync(join(parent, "package.json")) ? parent : undefined;
}

/** The walkthroughs' start pages (first two, signed in as `role` when given), else `/`. */
function startPages(walkthroughsDir: string, role: string | undefined): string[] {
  const pages: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(walkthroughsDir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    return ["/"];
  }
  for (const f of files) {
    try {
      const wf = loadWalkthroughFile(join(walkthroughsDir, f));
      const page = wf.start?.page;
      if (!page || !page.startsWith("/")) continue;
      if (role && wf.start?.persona?.role && wf.start.persona.role !== role) continue;
      if (!pages.includes(page)) pages.push(page);
      if (pages.length >= 2) break;
    } catch {
      // an unreadable walkthrough just isn't a source of pages
    }
  }
  return pages.length > 0 ? pages : ["/"];
}

/** The base URL as it may be committed: no credentials, query or fragment. */
export function publicBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

async function themeFromApp(config: ResolvedConfig, configFile: string, options: ThemeOptions): Promise<ThemeResult> {
  // Same gate as capture and inspect: even a read-only visit signs in.
  const refusal = await captureSafetyRefusal(config);
  if (refusal) throw new Error(refusal.error);
  const persona = resolvePersona(config.walkthroughsDir, options.as, configRoles(config));
  const pages = options.pages && options.pages.length > 0 ? options.pages : startPages(config.walkthroughsDir, persona?.role);
  const brandDir = join(config.configDir, "brand");
  const read = await readBrandFromApp({
    baseUrl: config.app.baseUrl,
    pages,
    signIn: config.signIn as never,
    persona,
    storageStatePath: join(config.buildDir, ".aida-session", `storageState-${storageStateKey(config.app.baseUrl, persona, config)}.json`),
    isSignInPath,
    assetsDir: brandDir,
    viewport: config.viewport,
    mask: config.mask,
  });
  const rel = (f?: string) => (f ? relative(config.configDir, f).split("\\").join("/") : undefined);
  const appBrand: BrandConfig = { ...read.brand };
  for (const k of ["logo", "logoDark", "icon"] as const) {
    const r = rel(read.assets[k]);
    if (r) appBrand[k] = r;
  }
  // Config values `aida init` copied from the repo (still equal to what repo detection finds) may
  // give way to the running app; anything else in the config is someone's choice and wins.
  const repo = appRepoFor(config, options.appRepo);
  const repoBrand = repo && existsSync(repo) ? rebaseBrandPaths(extractBrand(repo), repo, config.configDir) : undefined;
  const saved = writeAppBrand(config.configDir, {
    version: 1,
    source: { baseUrl: publicBaseUrl(config.app.baseUrl), pages },
    brand: appBrand,
    replaces: detectedReplaces(config.brand, repoBrand),
  });
  const helpAppDir = config.helpApp ?? config.configDir;
  const result = writeHelpAppTheme(config, helpAppDir);
  const merged = withAppBrand(config);
  const style = resolveBrandStyle(merged.brand, readBrandNotes(merged));
  return {
    mode: "from-app",
    configFile,
    helpAppDir,
    result,
    saved,
    pages,
    read: appBrand,
    notes: read.notes,
    fromApp: merged.brandFromApp ?? [],
    style,
  };
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

  if (out.mode === "from-app") {
    console.log(`brand read from the running app (${out.pages.join(", ")}) -> ${out.saved}`);
    for (const n of out.notes) console.log(`  ${n}`);
    for (const k of ["logo", "logoDark", "icon"] as const) if (out.read[k]) console.log(`  ${k} as drawn: ${out.read[k]}`);
    console.log(
      out.fromApp.length > 0
        ? `  outputs now use the app's: ${out.fromApp.join(", ")} (values you set in the config still win)`
        : "  nothing new: the config already sets everything the app showed",
    );
    console.log(`  style: ${out.style.style} (${out.style.source === "detected" ? "picked from the app's corners and shadows" : `from ${out.style.source}`})`);
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
