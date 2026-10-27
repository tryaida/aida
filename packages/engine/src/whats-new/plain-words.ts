// Turns a commit subject / PR title into a plain-words changelog line (build-plan.md M21 step
// 4: "plain-words entries"): strips the conventional-commit type/scope prefix and any trailing
// "(#123)" PR-number suffix, then capitalises the first letter.
const CONVENTIONAL_PREFIX = /^\w+(\([^)]*\))?!?:\s*/;
const PR_SUFFIX = /\s*\(#\d+\)\s*$/;

export function toPlainWords(subject: string): string {
  const stripped = subject.trim().replace(CONVENTIONAL_PREFIX, "").replace(PR_SUFFIX, "").trim();
  const text = stripped.length > 0 ? stripped : subject.trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
