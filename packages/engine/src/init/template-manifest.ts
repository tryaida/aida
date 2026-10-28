// The template manifest (build-plan.md M37): `<help>/.aida/template.json`, written by `aida init`
// and `aida upgrade`. It records, for each help-app template file, the sha256 of the template
// version last written into (or found unchanged in) the help app, plus the template's own
// package.json scripts and dependency ranges. `aida upgrade` compares the help app against it to
// tell a file the owner never touched (safe to replace) from one they changed (left alone).
//
// Only hashes are kept, not old file contents, so the manifest stays a few kilobytes. A file the
// owner changed is never merged: the new template version goes alongside it as `<file>.aida-new`.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { ENGINE_ROOT } from "../package-root.js";
import { AIDA_PACKAGE } from "../package-name.js";
import { listTemplateFiles, templateDestPath } from "./copy-template.js";

/** Where the manifest lives, relative to the help app (beside the Studio's history and locks). */
export const TEMPLATE_MANIFEST_PATH = ".aida/template.json";

/** package.json fields whose entries the manifest records and `aida upgrade` merges. */
export const PACKAGE_FIELDS = ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export type PackageField = (typeof PACKAGE_FIELDS)[number];
export type PackageSnapshot = Partial<Record<PackageField, Record<string, string>>>;

export interface TemplateManifest {
  version: 1;
  /** The engine version whose template was last recorded. */
  engineVersion: string;
  /** Help-app path (POSIX) -> sha256 of the template version recorded for it. */
  files: Record<string, string>;
  /** The template's package.json scripts and dependency ranges as last merged in, without
   * `aida-docs` (that points at the packed engine tarball, not the template's range). */
  packageJson?: PackageSnapshot;
}

/** Template files `aida upgrade` never writes, even though `aida init` copies a starter version:
 * the owner's content and walkthroughs, the theme files `aida theme` writes from the brand
 * (theme/write.ts), the search index and llms.txt the build writes, and package.json, which is
 * merged field by field instead. `aida.config.ts`, env files and vendor/ never come from the
 * template copy at all (copy-template.ts). */
const NOT_UPGRADED_PREFIXES = ["content/", "walkthroughs/", "public/brand/", "vendor/", ".aida/"];
const NOT_UPGRADED_FILES = new Set([
  "app/brand.css",
  "lib/brand.json",
  "public/search-index.json",
  "public/llms.txt",
  "package.json",
  "aida.config.ts",
]);

/** True for a help-app path (POSIX) whose file the template owns and `aida upgrade` may update. */
export function isUpgradeable(path: string): boolean {
  if (NOT_UPGRADED_FILES.has(path)) return false;
  if (/(^|\/)\.env(\..*)?$/.test(path)) return false;
  return !NOT_UPGRADED_PREFIXES.some((p) => path.startsWith(p));
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

/** Every upgradeable template file: help-app path (POSIX) -> its source in `templateDir`. */
export function upgradeableTemplateFiles(templateDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of listTemplateFiles(templateDir)) {
    const dest = toPosix(templateDestPath(rel));
    if (isUpgradeable(dest)) out.set(dest, join(templateDir, rel));
  }
  return out;
}

/** The running engine's version, from its package.json. */
export function engineVersion(engineRoot: string = ENGINE_ROOT): string {
  try {
    return (JSON.parse(readFileSync(join(engineRoot, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The scripts and dependency ranges of a package.json (the template's), without `aida-docs`. */
export function packageSnapshot(packageJsonFile: string): PackageSnapshot {
  const pkg = JSON.parse(readFileSync(packageJsonFile, "utf8")) as Record<string, unknown>;
  const snap: PackageSnapshot = {};
  for (const field of PACKAGE_FIELDS) {
    const entries = pkg[field];
    if (!entries || typeof entries !== "object") continue;
    const copy: Record<string, string> = {};
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (field !== "scripts" && name === AIDA_PACKAGE) continue;
      if (typeof value === "string") copy[name] = value;
    }
    if (Object.keys(copy).length > 0) snap[field] = copy;
  }
  return snap;
}

/** True for a manifest key that is a plain relative POSIX path inside the help app: not absolute,
 * no drive letter, no backslash, and no empty, `.` or `..` segment. The manifest is a file in the
 * owner's repo, so `aida upgrade` never trusts a key to stay inside the help app on its own. */
export function isSafeManifestPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path) || path.includes("\0")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** The help app's manifest, or undefined when there is none (an app scaffolded before M37) or it
 * can't be read. Entries whose key isn't a safe relative path (`isSafeManifestPath`), or isn't a
 * template-owned file, or whose hash isn't a sha256, are dropped. */
export function readTemplateManifest(helpDir: string): TemplateManifest | undefined {
  const file = join(helpDir, TEMPLATE_MANIFEST_PATH);
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Partial<TemplateManifest>;
    if (m.version !== 1 || !m.files || typeof m.files !== "object") return undefined;
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(m.files as Record<string, unknown>)) {
      if (isSafeManifestPath(path) && isUpgradeable(path) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) files[path] = hash;
    }
    return { version: 1, engineVersion: m.engineVersion ?? "unknown", files, packageJson: m.packageJson };
  } catch {
    return undefined;
  }
}

/** Why the manifest can't be written safely: `.aida` or `.aida/template.json` is a symbolic link
 * (writing would go wherever it points) or the wrong kind of entry. Undefined when it can. */
export function manifestWriteProblem(helpDir: string): string | undefined {
  const dir = join(helpDir, ".aida");
  for (const [path, want] of [[dir, "folder"], [join(helpDir, TEMPLATE_MANIFEST_PATH), "file"]] as const) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return undefined; // missing: created as a real folder and file
    }
    if (st.isSymbolicLink()) return `${path} is a symbolic link; aida won't write the template record through it. Replace it with a regular ${want}`;
    if (want === "folder" ? !st.isDirectory() : !st.isFile()) return `${path} is not a regular ${want}`;
  }
  return undefined;
}

/** Writes the manifest with sorted keys, so an unchanged template leaves the file byte-identical.
 * Throws, writing nothing, on a `manifestWriteProblem`. */
export function writeTemplateManifest(helpDir: string, manifest: TemplateManifest): string {
  const file = join(helpDir, TEMPLATE_MANIFEST_PATH);
  const problem = manifestWriteProblem(helpDir);
  if (problem) throw new Error(problem);
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const body = { ...manifest, files };
  if (!manifest.packageJson) delete body.packageJson;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
  return file;
}

/** For `aida init`, right after copying the template: records every template file the help app
 * now holds unchanged. A file init skipped because it was already there and differs keeps the
 * record an earlier init or upgrade made (or gets none, so `aida upgrade` treats it as the
 * owner's). The template's package.json is recorded when the help app's package.json was copied
 * from it just now, i.e. there was no earlier record. */
export function recordTemplateManifest(helpDir: string, templateDir: string, opts: { packageJsonCopied: boolean; engineRoot?: string }): string {
  const previous = readTemplateManifest(helpDir);
  const files: Record<string, string> = { ...(previous?.files ?? {}) };
  for (const [path, src] of upgradeableTemplateFiles(templateDir)) {
    const dest = join(helpDir, ...path.split("/"));
    if (!existsSync(dest)) continue;
    const hash = sha256File(src);
    if (sha256File(dest) === hash) files[path] = hash;
  }
  const packageJson = previous?.packageJson ?? (opts.packageJsonCopied ? packageSnapshot(join(templateDir, "package.json")) : undefined);
  return writeTemplateManifest(helpDir, { version: 1, engineVersion: engineVersion(opts.engineRoot), files, packageJson });
}
