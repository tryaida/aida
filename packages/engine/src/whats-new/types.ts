// Shared types for the What's New page (docs/scope.md "Help site": "What's new (written from
// merged PRs)"; build-plan.md M21 step 4).

/** One merge, from either source (git log merge/squash commits, or `gh pr list`), normalised to
 * a common shape before filtering/grouping/rendering. */
export interface MergeEntry {
  /** Commit hash (git source) or `pr-<number>` (GitHub source) — just needs to be stable/unique. */
  id: string;
  /** Raw subject line / PR title, before `toPlainWords`. */
  subject: string;
  /** ISO date this merge landed. */
  date: string;
  /** PR number, when known (parsed from a `(#123)` squash-merge subject, or straight from `gh`). */
  prNumber?: number;
  /** Link to the PR/commit, when known (only `gh` source sets this). */
  url?: string;
}

/** Maps one merge entry to the walkthrough id(s) it affected, when known. A separate builder
 * is adding `packages/engine/src/impact/` (git diff -> walkthrough mapping) in parallel — this
 * is the hook that plugs it in later without this module depending on it now. Returns `[]`/
 * `undefined` for "unknown", same as the impact map's own "unknown means all" default
 * (build-plan.md M17) would, but `whats-new` treats unknown as "general" (ungrouped) rather
 * than "every walkthrough", since a changelog entry under every page would be noise.
 */
export type WalkthroughMapper = (entry: MergeEntry) => string[] | undefined;

export interface GroupedEntry extends MergeEntry {
  /** Plain-words rendering of `subject` (conventional-commit prefix and PR-number suffix
   * stripped, first letter capitalised). */
  text: string;
  /** Walkthrough ids this entry affects, per `WalkthroughMapper` — empty when unmapped. */
  walkthroughIds: string[];
}

export interface BuildWhatsNewOptions {
  /** App repo to read merge history from (git log / gh pr list run with this as `cwd`). */
  appRepo: string;
  /** The help app directory the page gets written into (holds `content/docs/whats-new/`). */
  helpApp: string;
  /** Git ref/tag to diff from. Defaults to the last frozen version's `gitRef` (versions.json),
   * else the repo's very first commit. */
  since?: string;
  /** Use `gh pr list --state merged` instead of `git log` merge/squash commits. */
  fromGithub?: boolean;
  /** Injectable command runner (publish/types.ts `CommandRunner`) — tests always inject a fake
   * so this never shells out to git/gh for real. */
  runner: import("../publish/index.js").CommandRunner;
  /** Maps a merge entry to the walkthrough(s) it affects — see `WalkthroughMapper`. Omit while
   * the impact map (M17) isn't built yet; every entry renders ungrouped. */
  mapper?: WalkthroughMapper;
  now?: () => Date;
}

export interface BuildWhatsNewResult {
  pageFile: string;
  entryCount: number;
  skippedCount: number;
  since?: string;
  suggestions: { key: string; message: string }[];
}
