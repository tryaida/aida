// Changed-file discovery for `aida affected` (build-plan.md M17). Shells out to the system
// `git` binary rather than a library — the repo already has no git dependency, and `git diff
// --name-only` is the one primitive this needs.
import { execFileSync } from "node:child_process";

function git(appRepo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: appRepo, encoding: "utf8" });
  } catch (err) {
    const message = (err as Error & { stderr?: Buffer | string }).stderr?.toString() ?? (err as Error).message;
    throw new Error(`git ${args.join(" ")} failed in ${appRepo}: ${message.trim()}`);
  }
}

function splitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface GetChangedFilesOptions {
  /** Also includes uncommitted working-tree changes (staged + unstaged + untracked), relative to
   * `head`. Default false. */
  includeWorkingTree?: boolean;
}

/**
 * Changed files between `base` and `head` (default `"HEAD"`) in the app repo at `appRepo`, as
 * paths relative to `appRepo`'s root. Uses `base...head` (merge-base diff, not a straight
 * two-dot diff) so a PR branch's result doesn't include commits `base` picked up after the
 * branch forked. Passing an explicit `head` (e.g. `aida affected --base X^ --head X`) evaluates
 * one historic commit in isolation, rather than everything through the repo's current checkout.
 */
export function getChangedFiles(appRepo: string, base: string, head = "HEAD", opts: GetChangedFilesOptions = {}): string[] {
  const files = new Set<string>();
  for (const line of splitLines(git(appRepo, ["diff", "--name-only", `${base}...${head}`]))) files.add(line);

  if (opts.includeWorkingTree) {
    for (const line of splitLines(git(appRepo, ["diff", "--name-only", head]))) files.add(line);
    for (const line of splitLines(git(appRepo, ["ls-files", "--others", "--exclude-standard"]))) files.add(line);
  }

  return [...files].sort();
}
