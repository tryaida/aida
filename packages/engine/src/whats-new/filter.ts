// Filters out chores/deps/CI noise by conventional-commit prefix (build-plan.md M21 step 4:
// "Filter out chores/deps/CI by conventional prefixes").
const NOISE_PREFIX = /^(chore|ci|build|deps|dependabot|test|style|refactor)(\([^)]*\))?!?:\s*/i;

/** True when `subject` looks like a conventional-commit with a noise-type prefix
 * (`chore:`, `ci:`, `build(deps):`, ...). Anything else — including `feat:`, `fix:`, or a
 * subject with no conventional prefix at all — counts as noteworthy. */
export function isNoiseCommit(subject: string): boolean {
  return NOISE_PREFIX.test(subject.trim());
}
