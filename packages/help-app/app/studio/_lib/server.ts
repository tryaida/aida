// Server-only helpers shared by the Studio's route handlers. Thin by design (AGENTS.md: "keep
// the app thin, put logic in the engine package") — this just resolves file paths for the
// conventional `aida init` layout (aida.config.ts at the help app root, walkthroughsDir:
// "./walkthroughs", outDir: ".") and calls straight into the "aida-docs" engine package for
// everything else.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
// Deep imports (not the "aida-docs" package barrel): the barrel's index.ts re-exports the capture/
// voice/config modules too, and config/load.ts does a non-literal dynamic `import()` that
// Turbopack/webpack can't trace statically, which breaks bundling route handlers that pull in
// the barrel. Importing the specific submodules this file needs avoids that entirely.
import { loadWalkthroughFile, type Walkthrough } from "aida-docs/dist/walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "aida-docs/dist/capture/types.js";

/** The help app root — route handlers run with cwd at the help app root in both `next dev` and
 * `next start`. */
export function helpRoot(): string {
  return process.cwd();
}

export function walkthroughsDir(): string {
  return join(helpRoot(), "walkthroughs");
}

export function pagesDir(): string {
  return join(helpRoot(), "pages");
}

// Same slug the engine's walkthrough schema enforces for a walkthrough's own `walkthrough` id
// (packages/engine/src/walkthrough/schema.ts) — lowercase letters/digits, starting with one,
// hyphens as separators. Every route handler validates an id against this before using it,
// rather than trusting a request body/query string to be well-formed.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isSlug(id: string): boolean {
  return SLUG_PATTERN.test(id);
}

export function assertSlug(id: string): void {
  if (!isSlug(id)) throw new Error(`"${id}" is not a valid walkthrough id`);
}

/** Throws unless `file` resolves to inside `dir` — a belt-and-suspenders check behind
 * resolveWalkthroughFile/pageFileFor, which already only ever return paths they found by
 * listing `dir` themselves (never a caller-supplied path), so this should never actually fire. */
function assertInside(dir: string, file: string): void {
  const rel = relative(resolve(dir), resolve(file));
  if (rel.startsWith("..") || rel.split(/[\\/]/)[0] === "..") {
    throw new Error(`"${file}" resolved outside ${dir}`);
  }
}

/** "passed"/"failed" come from the last capture's validation.json; "captured" means a manifest
 * exists but no validation result; "not-captured" means aida has never captured it here. */
export type CaptureStatus = "passed" | "failed" | "captured" | "not-captured";

export interface WalkthroughSummary {
  id: string;
  file: string;
  title: string;
  stepCount: number;
  /** Contract 3: where the page sits in the help library ("Payments", "Entries / Late entries",
   * "Getting started"...). Undefined means the default "How do I…" group. */
  section?: string;
  summary?: string;
  status: CaptureStatus;
  lastChecked?: string;
}

/** The walkthrough's optional `section:` (Contract 3). Read loosely: the engine's schema gains the
 * field in the same release, and an older engine build simply never sets it. */
function sectionOf(wt: Walkthrough): string | undefined {
  const section = (wt as unknown as { section?: unknown }).section;
  return typeof section === "string" && section.trim() ? section.trim() : undefined;
}

/** Every walkthrough file under walkthroughsDir that parses, with its id. Files that fail to
 * parse are skipped rather than failing the whole list (`aida validate` reports them). */
function scanWalkthroughs(): { file: string; wt: Walkthrough }[] {
  const dir = walkthroughsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => [".yaml", ".yml"].includes(extname(f)));
  const out: { file: string; wt: Walkthrough }[] = [];
  for (const f of files) {
    const file = join(dir, f);
    try {
      out.push({ file, wt: loadWalkthroughFile(file) });
    } catch {
      // Skip invalid files — the Studio lists what it can.
    }
  }
  return out;
}

/** Every walkthrough, with what the Studio's library needs: title, step count, section
 * (Contract 3) and the last capture's pass/fail + when it was checked. */
export function listWalkthroughs(): WalkthroughSummary[] {
  return scanWalkthroughs()
    .map(({ file, wt }) => ({
      id: wt.walkthrough,
      file,
      title: wt.title,
      stepCount: wt.steps.length,
      section: sectionOf(wt),
      summary: wt.summary,
      ...(isSlug(wt.walkthrough) ? captureStatus(wt.walkthrough) : { status: "not-captured" as const }),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Resolves a walkthrough id to its YAML file, scanning walkthroughsDir. Throws if not found. */
export function resolveWalkthroughFile(id: string): string {
  assertSlug(id);
  const match = scanWalkthroughs().find((w) => w.wt.walkthrough === id);
  if (!match) throw new Error(`no walkthrough "${id}" under ${walkthroughsDir()}`);
  assertInside(walkthroughsDir(), match.file);
  return match.file;
}

export function loadWalkthroughById(id: string): Walkthrough {
  return loadWalkthroughFile(resolveWalkthroughFile(id));
}

/** The built page file for a walkthrough, if `aida pages`/`aida build` has run — tries the
 * `.mdx` then `.md` conventional output path (outDir: "."  -> ./pages/<id>/index.*). Returns
 * undefined if no page has been built yet. */
export function pageFileFor(id: string): string | undefined {
  assertSlug(id);
  const dir = join(pagesDir(), id);
  for (const name of ["index.mdx", "index.md"]) {
    const file = join(dir, name);
    if (existsSync(file)) {
      assertInside(pagesDir(), file);
      return file;
    }
  }
  return undefined;
}

export function readPageText(id: string): { file?: string; text?: string } {
  const file = pageFileFor(id);
  if (!file) return {};
  return { file, text: readFileSync(file, "utf8") };
}

// Matches `aida.config.ts`'s `buildDir: "..."` field (defineConfig's own generated shape —
// see packages/engine/src/init/*.ts's scaffold and config/types.ts's `AidaConfig.buildDir`).
// A plain text regex, not `config/load.ts`'s real loader: that loader's dynamic, non-literal
// `import(pathToFileURL(file).href)` is exactly what this file's other deep imports (see header
// comment) avoid, because it stops Turbopack/webpack from statically tracing a route handler
// that pulls it in. Reading the one field the Studio needs as plain text sidesteps that entirely
// — at the cost of only understanding a literal string (no template/computed path), which is
// what every `aida init`-generated config and the documented config shape both already use.
function configuredBuildDir(): string {
  for (const name of ["aida.config.ts", "aida.config.mjs", "aida.config.js"]) {
    const file = join(helpRoot(), name);
    // Same reasoning render/edit/page.js's own `resolve(opts.pagesDir)` already carries this
    // comment for: the path really is help-root-scoped at runtime (never user/request input —
    // `name` above is one of three hardcoded literals), Turbopack's static tracer just can't see
    // that through `helpRoot()`'s indirection.
    if (!existsSync(/* turbopackIgnore: true */ file)) continue;
    const text = readFileSync(/* turbopackIgnore: true */ file, "utf8");
    const m = text.match(/buildDir\s*:\s*["'`]([^"'`]+)["'`]/);
    if (m) return m[1];
    break;
  }
  return ".build";
}

/** `<config.buildDir>/<id>/capture` (default `.build`, same as `config/load.ts`'s own default)
 * — read-only lookups go through this (manifest + frame bytes for the screenshot editor); the
 * Studio never writes here. */
export function captureDirFor(id: string): string {
  assertSlug(id);
  const buildDir = configuredBuildDir();
  const resolved = isAbsolute(buildDir) ? buildDir : join(helpRoot(), buildDir);
  return join(resolved, id, "capture");
}

/** The latest capture manifest for a walkthrough, or `undefined` if it hasn't been captured
 * (yet, or ever) under this help app. */
export function readManifest(id: string): CaptureManifest | undefined {
  const file = join(captureDirFor(id), "manifest.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CaptureManifest;
  } catch {
    return undefined;
  }
}

/** Resolves a step's captured frame image to an absolute path inside `captureDir/frames/`, or
 * `undefined` if the walkthrough/step/frame isn't there. 1-based `stepNumber` matches how the
 * rest of the Studio (and pages/build.ts) numbers steps for people. */
export function frameFileFor(id: string, stepNumber: number): string | undefined {
  const manifest = readManifest(id);
  const step = manifest?.steps[stepNumber - 1];
  const image = step?.doc.image;
  if (!manifest || !step || !image) return undefined;
  const framesDir = join(captureDirFor(id), "frames");
  const file = join(framesDir, image);
  assertInside(framesDir, file);
  if (!existsSync(file)) return undefined;
  return file;
}

function readJsonIfExists<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Pass/fail and "last checked" for the Studio's status dots and top bar — the same sources, in
 * the same order, the engine's page builder uses for a page's `lastChecked`/`passed`
 * (pages/build.ts resolveLastChecked): run.json's ranAt, else validation.json's ranAt. */
export function captureStatus(id: string): { status: CaptureStatus; lastChecked?: string } {
  const dir = captureDirFor(id);
  const validation = readJsonIfExists<ValidationResult>(join(dir, "validation.json"));
  const run = readJsonIfExists<Record<string, unknown>>(join(dir, "run.json"));
  const ranAt = run && (typeof run.ranAt === "string" ? run.ranAt : typeof run.capturedAt === "string" ? run.capturedAt : undefined);
  const lastChecked = ranAt ?? validation?.ranAt;
  if (validation) return { status: validation.ok ? "passed" : "failed", lastChecked };
  if (existsSync(join(dir, "manifest.json"))) return { status: "captured", lastChecked };
  return { status: "not-captured" };
}

/** The walkthrough's page URL on the help site, for the Studio's "View on help site" link:
 * `public/procedures.json`'s `url` (Contract 3), else the `public/search-index.json` entry whose
 * URL ends in the walkthrough id (pages built before the library hierarchy existed), else
 * undefined (no site page yet — the Studio hides the link). Only ever returns a same-site path. */
export function siteUrlFor(id: string): string | undefined {
  assertSlug(id);
  const publicDir = join(helpRoot(), "public");
  const procedures = readJsonIfExists<{ id?: unknown; url?: unknown }[]>(join(publicDir, "procedures.json"));
  const proc = Array.isArray(procedures) ? procedures.find((p) => p && p.id === id) : undefined;
  if (proc && isSitePath(proc.url)) return proc.url;
  const index = readJsonIfExists<{ url?: unknown }[]>(join(publicDir, "search-index.json"));
  if (Array.isArray(index)) {
    const hit = index.find((e) => e && isSitePath(e.url) && (e.url === `/${id}` || e.url.endsWith(`/${id}`)));
    if (hit && isSitePath(hit.url)) return hit.url;
  }
  return undefined;
}

function isSitePath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

/** File modification time (ms) or undefined — lets the Studio say "the page was built before your
 * latest edits" without the client ever seeing a path. */
export function mtimeOf(file: string | undefined): number | undefined {
  if (!file || !existsSync(file)) return undefined;
  return statSync(file).mtimeMs;
}

// A screenshot file name as the page builder writes it (pages/content.ts screenshotFile:
// `step-01.png`), or any other plain image name a person dropped into the folder — never a path.
const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|gif)$/i;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Resolves an image a built page references (`screenshots/step-01.png`, `./screenshots/x.png`)
 * to a file inside `pages/<id>/screenshots/` for the Studio's page preview — read-only, and only
 * ever that one folder: the request names a bare file, which must match ASSET_NAME_PATTERN (no
 * slashes, no `..`), and the result is re-checked to sit inside the folder. */
export function pageAssetFile(id: string, name: string): { file: string; contentType: string } | undefined {
  assertSlug(id);
  if (!ASSET_NAME_PATTERN.test(name) || name.includes("..")) return undefined;
  const dir = join(pagesDir(), id, "screenshots");
  const file = join(dir, name);
  assertInside(dir, file);
  if (!existsSync(file)) return undefined;
  const ext = extname(name).slice(1).toLowerCase();
  return { file, contentType: IMAGE_TYPES[ext] ?? "application/octet-stream" };
}

export type VideoKind = "mp4" | "vtt";

/** The walkthrough's rendered video (or its captions) for the Studio's Video tab: the help app's
 * `public/videos/<id>/` copy (Contract 3) if there is one, else aida's own output folder
 * (`<outDir>/videos/<id>/`, outDir "." in a help app). File names are fixed (`<id>.mp4`,
 * `<id>.vtt`) — nothing from the request beyond the validated id and a two-value kind. */
export function videoFileFor(id: string, kind: VideoKind): string | undefined {
  assertSlug(id);
  const name = `${id}.${kind}`;
  for (const base of [join(helpRoot(), "public", "videos"), join(helpRoot(), "videos")]) {
    const dir = join(base, id);
    const file = join(dir, name);
    assertInside(dir, file);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export type ProofKind = "json" | "png";

/** The latest proof sheet (`aida proof`, decision 35): `<buildDir>/proof/proof.<kind>`. Fixed
 * names; nothing from the request but a two-value kind. */
export function proofFileFor(kind: ProofKind): string | undefined {
  const buildDir = configuredBuildDir();
  const dir = join(/* turbopackIgnore: true */ isAbsolute(buildDir) ? buildDir : join(/* turbopackIgnore: true */ helpRoot(), buildDir), "proof");
  const file = join(/* turbopackIgnore: true */ dir, `proof.${kind}`);
  assertInside(dir, file);
  return existsSync(/* turbopackIgnore: true */ file) ? file : undefined;
}
