// Copies the help-app template into a target directory for
// `aida init`. Never overwrites a file that's already there — a second
// `aida init` (or one run after the user has started editing) reports every
// such file as skipped instead of clobbering it.
//
// The template is `packages/help-app` in a clone of the aida repo, and `templates/help-app` inside
// the published package, bundled there at pack time by scripts/prepack.mjs using
// `listTemplateFiles` below (so the package ships exactly what this copies). See package-root.ts
// for why a clone always uses the live `packages/help-app`.
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ENGINE_ROOT, findResource, resourceCandidates } from "../package-root.js";

/** Where the help-app template may be, in lookup order (package-root.ts). */
export function templateCandidates(engineRoot: string = ENGINE_ROOT): string[] {
  return resourceCandidates(join("templates", "help-app"), join("packages", "help-app"), engineRoot);
}

/** The help-app template directory: the first candidate that has a package.json. */
export function findTemplateDir(engineRoot: string = ENGINE_ROOT): string {
  return findResource(templateCandidates(engineRoot), (dir) => existsSync(join(dir, "package.json")));
}

export const TEMPLATE_DIR = findTemplateDir();

/** npm never packs a file called `.gitignore` (or `.npmignore`), so the bundled template stores
 * them as `_gitignore` / `_npmignore`; copying restores the dot. */
const PACKED_DOTFILES: Record<string, string> = { _gitignore: ".gitignore", _npmignore: ".npmignore" };
/** The reverse of `PACKED_DOTFILES`, for the pack script. */
export const DOTFILES_FOR_PACKING: Record<string, string> = { ".gitignore": "_gitignore", ".npmignore": "_npmignore" };

/** The destination path (relative) for a template file: a packed dotfile gets its dot back. */
export function templateDestPath(rel: string): string {
  const restored = PACKED_DOTFILES[basename(rel)];
  return restored ? join(dirname(rel), restored) : rel;
}

// `aida.config.ts` is deliberately excluded from the plain copy: `write-config.ts` is the sole
// writer of that file, since it needs to fill in the detected app URL and brand per-repo.
const SKIP_NAMES = new Set([
  "node_modules", ".next", ".build", ".aida-session", ".source", "next-env.d.ts", "aida.config.ts", "vendor", "out",
]);
// Machine-local files a developer's own checkout of the template may hold: build caches, and env
// files that can carry API keys (never copy a key into another repo).
const SKIP_PATTERNS = [/\.tsbuildinfo$/, /^\.env(\..*)?$/];
// Brand assets the theme writer (src/theme/write.ts) copies per app — never carry one app's logo
// from the template into another. `app/brand.css` / `lib/brand.json` are still copied as the
// neutral defaults; `aida init` then rewrites them from the detected brand.
// `test/` holds the template's own vitest tests, which import from the monorepo's dev
// dependencies; in a scaffolded app they'd only break `next build`'s typecheck.
const SKIP_REL_PATHS = new Set([join("public", "brand"), "test"]);

export interface CopyTemplateResult {
  /** Files written, relative to `destDir`. */
  copied: string[];
  /** Files already present at the destination, left untouched, relative to `destDir`. */
  skipped: string[];
}

function listFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name) || SKIP_PATTERNS.some((re) => re.test(entry.name))) continue;
    const abs = join(dir, entry.name);
    const rel = join(base, entry.name);
    if (SKIP_REL_PATHS.has(rel)) continue;
    if (entry.isDirectory()) {
      listFiles(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** Every file `copyTemplate` would copy from `templateDir`, relative to it (machine-local files,
 * build output, env files and the template's own tests left out). */
export function listTemplateFiles(templateDir: string): string[] {
  const files: string[] = [];
  listFiles(templateDir, "", files);
  return files;
}

/** Copies every file under `templateDir` into `destDir`, creating directories as needed. Existing files at the destination are reported as skipped, never overwritten. */
export function copyTemplate(destDir: string, templateDir: string = TEMPLATE_DIR): CopyTemplateResult {
  if (!existsSync(templateDir)) {
    throw new Error(`help-app template not found at ${templateDir}`);
  }
  const files = listTemplateFiles(templateDir);

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const src = join(templateDir, rel);
    const destRel = templateDestPath(rel);
    const dest = join(destDir, destRel);
    if (existsSync(dest)) {
      skipped.push(destRel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied.push(destRel);
  }

  return { copied, skipped };
}

