// Reads the published (baseline) screenshots for a walkthrough, so `aida ci` can tell a
// cosmetic change from a broken/new walkthrough. The baseline lives wherever `aida build`'s
// index stage last published it: `publicDir` is `<config.helpApp>/public` when `helpApp` is set,
// else `config.outDir` (build-plan.md M18; see build/index-stage.ts `pruneUnpublishedScreenshots`).
//
// Two sources, both behind the same `BaselineSource` interface (run.ts/diff.ts don't care which):
//   - "disk" (default): the screenshots already sitting in the checkout — in a normal single-repo
//     CI run that's main's last publish (or, when the PR itself already touched them, the PR's own
//     working tree). No second checkout, no git-history lookup — this is what the orchestrator
//     review asked for, since the git-at-base path left every walkthrough looking "new" whenever
//     `base`/`head` are refs in a *different* repo than the one `publicDir` lives in (a
//     pilot's two-repo setup).
//   - "git": `git show <base>:<path>` in whatever repo contains `publicDir` — useful when the
//     working tree has already moved past `base` (e.g. replaying one historic commit in isolation)
//     and the on-disk screenshots no longer reflect it. Opt in with `baseline: "git"`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, join, isAbsolute, sep } from "node:path";

/** What `diff.ts` needs to compare against a baseline — screenshot bytes by walkthrough id +
 * file name, and which walkthrough ids have a baseline at all. */
export interface BaselineSource {
  getScreenshot(walkthroughId: string, fileName: string): Buffer | undefined;
  listWalkthroughIds(): string[];
}

/** Reads straight off disk — whatever `publicDir/screenshots/<id>/<file>` currently holds in
 * this checkout. Default source (see module doc above). */
export function diskBaselineSource(publicDir: string): BaselineSource {
  const screenshotsDir = join(publicDir, "screenshots");
  return {
    getScreenshot(walkthroughId, fileName) {
      const file = join(screenshotsDir, walkthroughId, fileName);
      return existsSync(file) ? readFileSync(file) : undefined;
    },
    listWalkthroughIds() {
      if (!existsSync(screenshotsDir)) return [];
      return readdirSync(screenshotsDir).filter((entry) => statSync(join(screenshotsDir, entry)).isDirectory());
    },
  };
}

/** Reads from git history at `ref`, in whatever repo contains `publicDir`. */
export function gitBaselineSource(lookup: BaselineLookup, ref: string): BaselineSource {
  return {
    getScreenshot(walkthroughId, fileName) {
      return getBaselineScreenshot(lookup, ref, walkthroughId, fileName);
    },
    listWalkthroughIds() {
      return listBaselineWalkthroughIds(lookup, ref);
    },
  };
}

/** Runs `git` in `repoRoot`, returning stdout, or `undefined` when the command fails (e.g. the
 * path doesn't exist at that ref) rather than throwing — a missing baseline is normal (new
 * walkthrough, or the screenshot dir didn't exist yet at `base`). */
function tryGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

function tryGitBuffer(repoRoot: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The git repo root containing `dir` (a parent directory with a `.git`), or `dir` itself when
 * none is found (e.g. in a test fixture with no `.git` at all — every lookup below then just
 * returns "not found", which is the right answer for a repo-less fixture). */
export function findRepoRoot(dir: string): string {
  const out = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return out ? out.trim() : dir;
}

export interface BaselineLookup {
  repoRoot: string;
  /** `publicDir`'s path relative to `repoRoot` (posix separators, as git wants). */
  screenshotsRelDir: string;
}

/** Builds the lookup `getBaselineScreenshot`/`listBaselineWalkthroughIds` need, from the resolved
 * `publicDir` (absolute). */
export function resolveBaselineLookup(publicDir: string): BaselineLookup {
  const repoRoot = findRepoRoot(publicDir);
  const rel = relative(repoRoot, join(publicDir, "screenshots")).split(sep).join("/");
  return { repoRoot, screenshotsRelDir: rel };
}

/** `git show <ref>:<path>` for one baseline screenshot; `undefined` when it doesn't exist at that
 * ref (new walkthrough or new step). */
export function getBaselineScreenshot(lookup: BaselineLookup, ref: string, walkthroughId: string, fileName: string): Buffer | undefined {
  const path = `${lookup.screenshotsRelDir}/${walkthroughId}/${fileName}`;
  return tryGitBuffer(lookup.repoRoot, ["show", `${ref}:${path}`]);
}

/** Walkthrough ids with at least one published screenshot at `ref` — used both to tell "new"
 * apart from "no baseline step N yet" and to compute `stalePages`. */
export function listBaselineWalkthroughIds(lookup: BaselineLookup, ref: string): string[] {
  const out = tryGit(lookup.repoRoot, ["ls-tree", "-r", "--name-only", ref, "--", lookup.screenshotsRelDir]);
  if (!out) return [];
  const ids = new Set<string>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rel = trimmed.slice(lookup.screenshotsRelDir.length + 1);
    const id = rel.split("/")[0];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The commit sha a ref resolves to in `repoRoot` — used for `raw.githubusercontent.com` image
 * URLs in the PR comment, which need a sha, not a ref name. */
export function resolveSha(repoRoot: string, ref: string): string | undefined {
  const out = tryGit(repoRoot, ["rev-parse", ref]);
  return out ? out.trim() : undefined;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
