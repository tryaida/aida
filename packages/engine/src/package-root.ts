// Where the engine finds the files it copies into other repos (the help-app template, the agent
// skills). They live in two places:
//
// - In a clone of the aida repo they're the live sources at the repo root: `packages/help-app`
//   and `skills/`, siblings of this package.
// - In the published package `aida-docs` (installed from npm, or run with `npx aida-docs`) there
//   is no monorepo; `npm pack` bundles copies into the package (`templates/help-app`, `skills/`,
//   see scripts/prepack.mjs).
//
// A clone uses the live sources, even when bundled copies are present: those only exist between
// `prepack` and `postpack` (or after an interrupted pack) and may be older than the sources, so
// preferring them would make `aida init` from a clone silently ignore edits to packages/help-app.
// The monorepo is recognised by its root package.json, not just by a sibling folder existing:
// installed under `node_modules/aida-docs`, `../../skills` would be the user's own project folder.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The engine package root: this file is `src/package-root.ts` under tsx, `dist/package-root.js`
 * when built, and `node_modules/aida-docs/dist/package-root.js` when installed. */
export const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The aida monorepo's root package.json `name`. */
export const MONOREPO_PACKAGE_NAME = "aida-monorepo";

/** The aida monorepo root when this engine is `packages/engine` inside a clone of it, else
 * undefined (the engine is an installed package). */
export function monorepoRoot(engineRoot: string = ENGINE_ROOT): string | undefined {
  if (basename(engineRoot) !== "engine" || basename(dirname(engineRoot)) !== "packages") return undefined;
  const root = dirname(dirname(engineRoot));
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === MONOREPO_PACKAGE_NAME ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Where to look for a resource, in order: the live monorepo copy (`monorepoRel` under the repo
 * root) when running from a clone, then the copy bundled in the package (`bundledRel` under the
 * package root). */
export function resourceCandidates(bundledRel: string, monorepoRel: string, engineRoot: string = ENGINE_ROOT): string[] {
  const root = monorepoRoot(engineRoot);
  const bundled = join(engineRoot, bundledRel);
  return root ? [join(root, monorepoRel), bundled] : [bundled];
}

/** The first candidate for which `isPresent` holds, else the first candidate (so the caller's
 * "not found" message names where it looked first). */
export function findResource(candidates: string[], isPresent: (dir: string) => boolean = existsSync): string {
  return candidates.find((dir) => isPresent(dir)) ?? candidates[0];
}
