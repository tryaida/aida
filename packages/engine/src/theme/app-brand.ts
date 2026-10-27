// The brand read from the running app (`aida theme --from-app`, decision 35), kept beside the
// config in `brand/from-app.json` (+ the logo and icon as drawn) and merged under `config.brand`
// wherever a brand is resolved: the help app's theme files (theme/write.ts) and every artifact
// (render/brand.ts's `resolveArtifactBrand`). aida never edits a user's config, so this file is
// how a later `--from-app` run reaches every output.
//
// Precedence: explicit config > running app > repo files. A config value is "explicit" unless it
// still equals what repo detection put there when the app was read (recorded in `replaces`), so
// a value `aida init` copied from the repo gives way to the running app, but anything a person
// typed (or changed since) always wins. Repo logo files are kept over the drawn logo: they're
// the original artwork.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrandColors, BrandConfig } from "../config/types.js";
import { sameColor } from "./color.js";

export const APP_BRAND_DIR = "brand";
export const APP_BRAND_FILE = "from-app.json";

/** Fields the merge treats one by one. `primary` is `primaryColor ?? colors.primary`; `accent`
 * likewise; `font` carries `fontUrl` with it. */
export const MERGE_FIELDS = [
  "name",
  "primary",
  "accent",
  "colors.primaryForeground",
  "colors.background",
  "colors.foreground",
  "colors.muted",
  "colors.mutedForeground",
  "colors.border",
  "colors.card",
  "font",
  "headingFont",
  "radius",
  "shadow",
  "density",
  "logo",
  "logoDark",
  "icon",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

const LOGO_FIELDS: ReadonlySet<MergeField> = new Set(["logo", "logoDark", "icon"]);
const COLOR_FIELDS: ReadonlySet<MergeField> = new Set(MERGE_FIELDS.filter((f) => f === "primary" || f === "accent" || f.startsWith("colors.")));

export interface AppBrandFile {
  version: 1;
  /** Where it was read from: the app's base URL and the paths opened. */
  source: { baseUrl: string; pages: string[] };
  /** Values read from the app (paths relative to the config dir, like `config.brand`). */
  brand: BrandConfig;
  /** Config values that were repo-detected when the app was read (so the app may replace them
   * while they stay unchanged). Keyed by `MergeField`. */
  replaces: Partial<Record<MergeField, string>>;
}

/** One field's value from a brand (strings only; undefined when unset/empty). */
export function fieldValue(b: BrandConfig | undefined, f: MergeField): string | undefined {
  if (!b) return undefined;
  let v: unknown;
  if (f === "primary") v = b.primaryColor ?? b.colors?.primary;
  else if (f === "accent") v = b.accentColor ?? b.colors?.accent;
  else if (f.startsWith("colors.")) v = b.colors?.[f.slice(7) as keyof BrandColors];
  else v = (b as Record<string, unknown>)[f];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function sameValue(f: MergeField, a: string, b: string): boolean {
  if (COLOR_FIELDS.has(f)) return sameColor(a, b);
  return a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();
}

function setField(out: BrandConfig, f: MergeField, v: string): void {
  if (f === "primary") {
    out.primaryColor = v;
    if (out.colors) delete out.colors.primary;
  } else if (f === "accent") {
    out.accentColor = v;
    if (out.colors) delete out.colors.accent;
  } else if (f.startsWith("colors.")) {
    out.colors = { ...(out.colors ?? {}), [f.slice(7)]: v };
  } else {
    (out as Record<string, unknown>)[f] = v;
  }
}

export interface MergedBrand {
  brand: BrandConfig | undefined;
  /** Fields whose value came from the running app. */
  fromApp: MergeField[];
}

/**
 * `explicit` (config.brand) with `app` merged under it. `replaces` lists config values that were
 * repo-detected (not typed by a person) when the app was read: while a config field still holds
 * exactly that value, the app's value replaces it. Logos: a configured logo file that exists
 * (`logoExists`) is always kept.
 */
export function mergeAppBrand(
  explicit: BrandConfig | undefined,
  app: BrandConfig | undefined,
  replaces: Partial<Record<MergeField, string>> = {},
  logoExists: (relPath: string) => boolean = () => true,
): MergedBrand {
  if (!app) return { brand: explicit, fromApp: [] };
  const out: BrandConfig = structuredClone(explicit ?? {});
  const fromApp: MergeField[] = [];
  for (const f of MERGE_FIELDS) {
    const a = fieldValue(app, f);
    if (a === undefined) continue;
    // The app's own logo and icon only ever as PNGs aida rendered (never app-provided markup such
    // as an SVG, which the help site would then serve from its own origin).
    if (LOGO_FIELDS.has(f) && !/\.png$/i.test(a)) continue;
    const e = fieldValue(explicit, f);
    // Already the same: nothing to change (and a font keeps its own stylesheet URL).
    if (e !== undefined && !LOGO_FIELDS.has(f) && sameValue(f, e, a)) continue;
    let useApp: boolean;
    if (e === undefined) useApp = true;
    else if (LOGO_FIELDS.has(f)) useApp = !logoExists(e);
    else {
      const r = replaces[f];
      useApp = r !== undefined && sameValue(f, e, r);
    }
    if (!useApp) continue;
    setField(out, f, a);
    if (f === "font") {
      // A font's stylesheet belongs to that font: never pair the app's font with the repo's URL.
      if (app.fontUrl) out.fontUrl = app.fontUrl;
      else delete out.fontUrl;
    }
    fromApp.push(f);
  }
  // A preset someone chose stays; one the app suggests fills the gap.
  if (!out.style && app.style) out.style = app.style;
  return { brand: out, fromApp };
}

export function appBrandPath(configDir: string): string {
  return path.join(configDir, APP_BRAND_DIR, APP_BRAND_FILE);
}

/** The saved app brand next to a config, or undefined when there's none (or it's unreadable). */
export function readAppBrand(configDir: string): AppBrandFile | undefined {
  const file = appBrandPath(configDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AppBrandFile;
    if (parsed?.version !== 1 || typeof parsed.brand !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Writes `brand/from-app.json` (stable key order, trailing newline). Returns the path. */
export function writeAppBrand(configDir: string, data: AppBrandFile): string {
  const file = appBrandPath(configDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** `config` with the saved app brand merged under `config.brand` (see `mergeAppBrand`). The one
 * place every brand consumer goes through, so site, Studio, video and PDFs agree. */
export function withAppBrand<T extends { configDir: string; brand?: BrandConfig }>(config: T): T & { brandFromApp?: MergeField[] } {
  const saved = readAppBrand(config.configDir);
  if (!saved) return config;
  const exists = (rel: string) => existsSync(path.resolve(config.configDir, rel));
  const { brand, fromApp } = mergeAppBrand(config.brand, saved.brand, saved.replaces, exists);
  return { ...config, brand, brandFromApp: fromApp };
}

/** Config fields that still equal what repo detection finds: those may be replaced by the app. */
export function detectedReplaces(explicit: BrandConfig | undefined, repoDetected: BrandConfig | undefined): Partial<Record<MergeField, string>> {
  const out: Partial<Record<MergeField, string>> = {};
  for (const f of MERGE_FIELDS) {
    if (LOGO_FIELDS.has(f)) continue;
    const e = fieldValue(explicit, f);
    const d = fieldValue(repoDetected, f);
    if (e !== undefined && d !== undefined && sameValue(f, e, d)) out[f] = e;
  }
  return out;
}
