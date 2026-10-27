// Result shapes for `aida affected` (build-plan.md M17). Kept stable deliberately: M18 (a
// GitHub Action/PR check) and M19 (change tiers) build directly on `AffectedResult`.

export interface WalkthroughAffected {
  id: string;
  affected: boolean;
  /** Human-readable reasons, e.g. "changed app/teams/[id]/page.tsx -> route /teams/[id] -> step 3
   * (route /teams/[id])", or "walkthrough file changed", or "no capture manifest — always
   * affected". Empty when `affected` is false. */
  reasons: string[];
}

export interface AffectedResult {
  /** The `--base` ref the diff was taken against. */
  base: string;
  /** The `--head` ref the diff was taken against. Default `"HEAD"`. */
  head: string;
  /** Changed files, relative to the app repo root, as returned by `git diff`. */
  changedFiles: string[];
  /** True when the diff couldn't be mapped precisely and every walkthrough is treated as affected. */
  all: boolean;
  /** Set when `all` is true: why (e.g. which file forced it, or an ambiguous-monorepo digest result). */
  reason?: string;
  walkthroughs: WalkthroughAffected[];
}
