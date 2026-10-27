// The on-screen names a step's actions found (M29 outline drift): role names, labels,
// placeholders, literal text, `hasText`, `within`/`padUnion`/highlight targets and select options.
// Recorded per step in the capture manifest (`ManifestStep.targets`) so `aida outline` can
// compare an outline card's promised labels with what was actually on screen. Taken from the
// walkthrough as written (before `{{...}}` values are filled in): a templated name is demo data,
// not a label, and leaving it out keeps the manifest identical across runs.
import type { Action, Target } from "../walkthrough/index.js";

/** capture/locate.ts `textArg`: only `text` of the form `/.../` (no flags) becomes a RegExp. */
const REGEX_TEXT = /^\/.*\/$/;

function fromTarget(t: Target | undefined, out: string[]): void {
  if (!t) return;
  for (const v of [t.name, t.label, t.placeholder, t.text, t.hasText]) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || s.includes("{{")) continue;
    // A "/regex/" text target names a pattern, not a label. Same test as capture/locate.ts's
    // `textArg`, on the untrimmed value and with no flags: locate.ts reads "/foo/i" as the literal
    // text "/foo/i", so it is a name here too.
    if (v === t.text && REGEX_TEXT.test(v)) continue;
    out.push(s);
  }
  fromTarget(t.within, out);
  fromTarget(t.padUnion, out);
}

/** Unique names, in the order the actions use them. */
export function targetNames(actions: readonly Action[] | undefined): string[] {
  const out: string[] = [];
  for (const a of actions ?? []) {
    if ("target" in a) fromTarget(a.target, out);
    if ("highlight" in a && a.highlight && typeof a.highlight === "object") fromTarget(a.highlight, out);
    if (a.do === "select" && a.option.trim() && !a.option.includes("{{")) out.push(a.option.trim());
  }
  return [...new Set(out)];
}

/** `{ targets }` for a manifest step, or nothing when the step names nothing. */
export function seenTargets(actions: readonly Action[] | undefined): { targets?: string[] } {
  const targets = targetNames(actions);
  return targets.length > 0 ? { targets } : {};
}
