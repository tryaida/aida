// House style presets (docs/scope.md "House styles", decision 35): `minimal`, `friendly` or
// `bold`. One name picks motion, transitions, zoom, cursor, callout shape, caption box, PDF
// cover layout and screenshot framing for every output; the app's colours and fonts sit on top.
// Resolution, in order: `config.brand.style`, `brand.md`'s `style:` frontmatter, then a default
// read off the app's own corner radius and shadows. Pure and deterministic.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { BrandConfig } from "../config/types.js";

export type BrandStyle = "minimal" | "friendly" | "bold";
export const BRAND_STYLES: readonly BrandStyle[] = ["minimal", "friendly", "bold"];

export function isBrandStyle(value: unknown): value is BrandStyle {
  return typeof value === "string" && (BRAND_STYLES as readonly string[]).includes(value);
}

/** A CSS length as px (`0.5rem` -> 8, `10px` -> 10, `12` -> 12); undefined when unreadable. */
export function radiusPx(radius: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|rem|em)?\s*$/i.exec(radius ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] && /r?em/i.test(m[2]) ? n * 16 : n;
}

/** The preset an app's own look suggests: generous corners read as friendly, square and flat as
 * minimal, everything else (and an unknown look) as bold. */
export function defaultStyle(brand: Pick<BrandConfig, "radius" | "shadow"> | undefined): BrandStyle {
  const r = radiusPx(brand?.radius);
  if (r !== undefined && r >= 12) return "friendly";
  if (brand?.shadow === "strong") return "bold";
  if ((r !== undefined && r <= 4) || brand?.shadow === "none") return "minimal";
  return "bold";
}

/** `brand.md`'s structured part: only these keys are read; the rest of the file is for agents. */
export interface BrandNotes {
  /** Absolute path of the file read. */
  file: string;
  style?: BrandStyle;
  /** A short line for video outros and PDF covers. */
  tagline?: string;
}

const MAX_NOTES_BYTES = 64_000;

/** Reads `brand.notes` (default `brand.md` next to the config) and its frontmatter. Undefined
 * when there's no such file. Unknown keys and values are ignored, never an error. */
export function readBrandNotes(config: { configDir: string; brand?: Pick<BrandConfig, "notes"> }): BrandNotes | undefined {
  const file = path.resolve(config.configDir, config.brand?.notes ?? "brand.md");
  if (!existsSync(file)) return undefined;
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_NOTES_BYTES) return undefined;
  return { file, ...parseBrandNotes(readFileSync(file, "utf8")) };
}

/** `style:` and `tagline:` from a `---` frontmatter block (simple `key: value` lines). */
export function parseBrandNotes(text: string): Omit<BrandNotes, "file"> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Omit<BrandNotes, "file"> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-zA-Z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/^["']|["']$/g, "").trim();
    if (kv[1] === "style" && isBrandStyle(value)) out.style = value;
    if (kv[1] === "tagline" && value) out.tagline = value.slice(0, 120);
  }
  return out;
}

export interface ResolvedStyle {
  style: BrandStyle;
  source: "config" | "brand.md" | "detected";
  tagline?: string;
}

/** The preset every output uses for this brand, and where it came from. */
export function resolveBrandStyle(brand: BrandConfig | undefined, notes?: Omit<BrandNotes, "file">): ResolvedStyle {
  const tagline = notes?.tagline;
  if (isBrandStyle(brand?.style)) return { style: brand!.style!, source: "config", tagline };
  if (notes?.style) return { style: notes.style, source: "brand.md", tagline };
  return { style: defaultStyle(brand), source: "detected", tagline };
}
