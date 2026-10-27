// Copies the packages/help-app template into a target directory for
// `aida init`. Never overwrites a file that's already there — a second
// `aida init` (or one run after the user has started editing) reports every
// such file as skipped instead of clobbering it.
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// TODO(publish): once `aida` ships as a published package, bundle the
// template into dist (e.g. `files: ["dist", "template"]`) instead of reaching
// across the monorepo like this.
const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(here, "..", "..", "..", "help-app");

// `aida.config.ts` is deliberately excluded from the plain copy: `write-config.ts` is the sole
// writer of that file, since it needs to fill in the detected app URL and brand per-repo.
const SKIP_NAMES = new Set([
  "node_modules", ".next", ".build", ".aida-session", ".source", "next-env.d.ts", "aida.config.ts", "vendor",
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

/** Copies every file under `templateDir` into `destDir`, creating directories as needed. Existing files at the destination are reported as skipped, never overwritten. */
export function copyTemplate(destDir: string, templateDir: string = TEMPLATE_DIR): CopyTemplateResult {
  if (!existsSync(templateDir)) {
    throw new Error(`help-app template not found at ${templateDir}`);
  }
  const files: string[] = [];
  listFiles(templateDir, "", files);

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const src = join(templateDir, rel);
    const dest = join(destDir, rel);
    if (existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied.push(rel);
  }

  return { copied, skipped };
}

