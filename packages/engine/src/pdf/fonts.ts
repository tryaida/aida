// Real embedded fonts for the PDFs (decision 36). Chromium prints a variable webfont — what a
// modern browser gets from a font stylesheet like Google Fonts' css2 API — as Type 3 glyphs:
// blurry when zoomed and not reliably searchable. The same stylesheet asked for without a
// browser user agent lists one static TrueType file per weight, which Chromium embeds as real
// CID TrueType fonts. This fetches that stylesheet once, downloads the files into a cache dir,
// and returns `@font-face` rules pointing at the local copies, so later (and offline) builds
// need no network. Anything that fails returns undefined and the caller keeps its fallback.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Default font cache: `.aida-cache/fonts` under the working directory (as `.aida-cache/voice`). */
export function defaultFontCacheDir(): string {
  return path.join(process.cwd(), ".aida-cache", "fonts");
}

export interface CachedFontFace {
  family: string;
  style: "normal" | "italic";
  /** A single weight ("400") or a variable range ("100 900"). */
  weight: string;
  unicodeRange?: string;
  /** Absolute path of the downloaded font file. */
  file: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
}

const FAMILY = /^[A-Za-z0-9 _-]{1,64}$/;
const WEIGHT = /^\d{3}( \d{3})?$/;
const RANGE = /^[Uu+0-9A-Fa-f?, -]{1,4000}$/;
const MAX_FONT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function formatOf(url: string, declared?: string): CachedFontFace["format"] | undefined {
  const f = (declared ?? "").toLowerCase();
  if (f === "truetype" || f === "opentype" || f === "woff" || f === "woff2") return f;
  const ext = /\.(ttf|otf|woff2?|)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext === "woff" ? "woff" : ext === "woff2" ? "woff2" : undefined;
}

/** Parses a font stylesheet's `@font-face` blocks into checked fields (never passed through as
 * raw CSS: the stylesheet comes off the network and lands in the print HTML). */
export function parseFontFaces(css: string): Array<Omit<CachedFontFace, "file"> & { url: string }> {
  const out: Array<Omit<CachedFontFace, "file"> & { url: string }> = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1];
    const prop = (name: string): string | undefined => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(body)?.[1]?.trim();
    const family = prop("font-family")?.replace(/^['"]|['"]$/g, "");
    const style = (prop("font-style") ?? "normal").toLowerCase();
    const weight = (prop("font-weight") ?? "400").replace(/\s+/g, " ");
    const range = prop("unicode-range");
    const src = /url\(\s*['"]?(https:\/\/[^'")\s]+)['"]?\s*\)(?:\s*format\(\s*['"]?([a-z0-9]+)['"]?\s*\))?/i.exec(prop("src") ?? "");
    if (!family || !FAMILY.test(family) || !WEIGHT.test(weight) || !src) continue;
    if (style !== "normal" && style !== "italic") continue;
    if (range && !RANGE.test(range)) continue;
    const format = formatOf(src[1], src[2]);
    if (!format) continue;
    out.push({ family, style, weight, ...(range ? { unicodeRange: range } : {}), url: src[1], format });
  }
  return out;
}

/** Biggest font stylesheet read (they're a few KB). */
export const MAX_STYLESHEET_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const CACHED_FILE = /^[A-Za-z0-9._-]{1,128}\.(ttf|otf|woff2?)$/;
const FORMATS = new Set(["truetype", "opentype", "woff", "woff2"]);

/**
 * GETs `url` over https only — every redirect hop is followed by hand and must stay https — and
 * reads at most `maxBytes` (a declared larger `content-length` is refused up front; a body that
 * grows past the cap is aborted mid-stream). Undefined on any failure or timeout.
 */
export async function fetchCapped(url: string, maxBytes: number): Promise<Buffer | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!/^https:\/\//i.test(current)) return undefined;
      // No browser user agent on purpose: font services answer it with static per-weight files.
      const res = await fetch(current, { signal: ctrl.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) return undefined;
        current = new URL(location, current).href;
        continue;
      }
      if (!res.ok || !res.body) return undefined;
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body.cancel();
        return undefined;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** A cached index entry is only trusted if it still passes the same checks a freshly parsed
 * face does, and its file is a plain name inside `cacheDir` (the index is a file on disk that
 * ends up in the print HTML). */
function validCachedFace(f: CachedFontFace, cacheDir: string): boolean {
  return (
    typeof f?.family === "string" && FAMILY.test(f.family) &&
    (f.style === "normal" || f.style === "italic") &&
    typeof f.weight === "string" && WEIGHT.test(f.weight) &&
    (f.unicodeRange === undefined || (typeof f.unicodeRange === "string" && RANGE.test(f.unicodeRange))) &&
    FORMATS.has(f.format) &&
    typeof f.file === "string" &&
    path.dirname(path.resolve(f.file)) === path.resolve(cacheDir) &&
    CACHED_FILE.test(path.basename(f.file)) &&
    existsSync(f.file)
  );
}

/**
 * The `fontUrl` stylesheet's faces with every file downloaded under `cacheDir`, or undefined.
 * A complete, valid earlier download is reused without touching the network. https only.
 */
export async function cacheFontFaces(fontUrl: string, cacheDir: string): Promise<CachedFontFace[] | undefined> {
  if (!/^https:\/\//i.test(fontUrl)) return undefined;
  const indexFile = path.join(cacheDir, `${sha(fontUrl)}.json`);
  if (existsSync(indexFile)) {
    try {
      const faces = JSON.parse(readFileSync(indexFile, "utf8")) as CachedFontFace[];
      if (Array.isArray(faces) && faces.length > 0 && faces.every((f) => validCachedFace(f, cacheDir))) return faces;
    } catch {
      // Unreadable index: fetch again below.
    }
  }
  try {
    const css = await fetchCapped(fontUrl, MAX_STYLESHEET_BYTES);
    if (!css) return undefined;
    const parsed = parseFontFaces(css.toString("utf8"));
    if (parsed.length === 0) return undefined;
    mkdirSync(cacheDir, { recursive: true });
    const faces: CachedFontFace[] = [];
    for (const face of parsed) {
      const ext = face.format === "truetype" ? "ttf" : face.format === "opentype" ? "otf" : face.format;
      const file = path.join(cacheDir, `${sha(face.url)}.${ext}`);
      if (!existsSync(file)) {
        const bytes = await fetchCapped(face.url, MAX_FONT_BYTES);
        if (!bytes || bytes.length === 0) return undefined;
        writeFileSync(file, bytes);
      }
      const { url: _url, ...rest } = face;
      faces.push({ ...rest, file });
    }
    writeFileSync(indexFile, JSON.stringify(faces, null, 2));
    return faces;
  } catch {
    return undefined;
  }
}

/** `@font-face` rules for cached faces, loading each from its local file. */
export function fontFaceCss(faces: CachedFontFace[]): string {
  return faces
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; font-style: ${f.style}; font-weight: ${f.weight}; ` +
        `src: url("file://${encodeURI(f.file)}") format("${f.format}");${f.unicodeRange ? ` unicode-range: ${f.unicodeRange};` : ""} }`,
    )
    .join("\n");
}
