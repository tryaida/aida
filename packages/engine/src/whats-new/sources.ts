// Two interchangeable sources of merged-work history (build-plan.md M21 step 4): `git log`
// merge/squash-merge commit subjects on the app repo (default, no network, no auth needed), or
// `gh pr list --state merged` when `--from-github` is set and `gh` is available. Both go
// through the same injectable `CommandRunner` (publish/types.ts) the publish module already
// uses, so tests assert on exact commands without a real git/gh process.
import type { CommandRunner } from "../publish/index.js";
import type { MergeEntry } from "./types.js";

const UNIT_SEP = "\x1f"; // never appears in a commit subject/date, unlike "|" or ",".

function parsePrNumber(subject: string): number | undefined {
  // Matches both GitHub's default squash-merge suffix ("Add thing (#123)") and a merge commit
  // subject ("Merge pull request #123 from ...").
  const match = /#(\d+)/.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/**
 * `git log <since>..HEAD` (or `git log HEAD` when `since` is omitted — the whole history),
 * one entry per commit, oldest-to-caller-ordering left to the git output (newest first).
 * Every commit is returned, not just merges — a repo that squash-merges PRs (GitHub's default)
 * has no merge commits at all, so filtering to `--merges` would return nothing; conventional-
 * prefix filtering (filter.ts) is what removes noise instead.
 */
export async function listMergedCommits(runner: CommandRunner, appRepo: string, since?: string): Promise<MergeEntry[]> {
  const range = since ? `${since}..HEAD` : "HEAD";
  const result = await runner("git", ["log", range, `--pretty=format:%H${UNIT_SEP}%aI${UNIT_SEP}%s`], { cwd: appRepo });
  if (result.code !== 0) {
    throw new Error(`git log failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash, date, subject = ""] = line.split(UNIT_SEP);
      return { id: hash, date, subject, prNumber: parsePrNumber(subject) };
    });
}

interface GhPrListRow {
  number: number;
  title: string;
  mergedAt: string;
  url?: string;
}

/**
 * `gh pr list --state merged`. `since` is only applied when it parses as an ISO date (a git ref
 * like a tag name can't be compared against `mergedAt` without resolving it to a date first,
 * which would need another `git log -1 --format=%aI <ref>` call) — when `since` isn't a date,
 * every merged PR `gh` returns is kept, and the caller's own date range (if any) is left to a
 * future improvement. This is a known gap, not a silent wrong answer: `since` being ignored
 * here is called out in `aida whats-new`'s receipt/output, not hidden.
 */
export async function listMergedPullRequests(runner: CommandRunner, appRepo: string, since?: string): Promise<MergeEntry[]> {
  const result = await runner(
    "gh",
    ["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,title,mergedAt,url"],
    { cwd: appRepo },
  );
  if (result.code !== 0) {
    throw new Error(`gh pr list failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  let rows: GhPrListRow[];
  try {
    rows = JSON.parse(result.stdout) as GhPrListRow[];
  } catch {
    throw new Error("gh pr list returned output that wasn't valid JSON");
  }

  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? Date.parse(since) : undefined;
  return rows
    .filter((row) => sinceDate === undefined || Date.parse(row.mergedAt) > sinceDate)
    .map((row) => ({ id: `pr-${row.number}`, subject: row.title, date: row.mergedAt, prNumber: row.number, url: row.url }));
}
