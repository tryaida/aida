// An expect's `text` (M38) is literal text, or a pattern written `/source/` (or `/source/i` to
// ignore case). Patterns are compiled when a walkthrough loads, so a broken one fails validate
// rather than a capture, and kept simple enough that matching can't hang a capture.

const PATTERN = /^\/(.*)\/([a-z]*)$/s;
const MAX_PATTERN = 200;

export interface TextPattern {
  source: string;
  flags: string;
}

/** The pattern a `/…/` text is, or undefined for literal text. */
export function textPattern(text: string): TextPattern | undefined {
  const m = PATTERN.exec(text);
  return m ? { source: m[1], flags: m[2] } : undefined;
}

/** Why a `/…/` text can't be used, or undefined when it can (or it's literal text). */
export function textPatternProblem(text: string): string | undefined {
  const p = textPattern(text);
  if (!p) return undefined;
  if (p.flags && p.flags !== "i") return `pattern ${text} has flags "${p.flags}": only "i" (ignore case) is supported`;
  if (p.source === "") return "an empty pattern // matches everything: write the text to look for between the slashes";
  if (p.source.length > MAX_PATTERN) return `pattern is longer than ${MAX_PATTERN} characters: check for a shorter piece of the text`;
  // A repeated group that itself repeats ((a+)+, (.*)*) can take forever on text that nearly matches.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(p.source)) {
    return `pattern ${text} repeats a group that itself repeats, which can hang: simplify it`;
  }
  try {
    new RegExp(p.source, p.flags);
  } catch (err) {
    return `pattern ${text} isn't a valid regular expression (${err instanceof Error ? err.message : String(err)})`;
  }
  return undefined;
}

/** A literal string as a `/…/` pattern that matches exactly that text (for text that would
 * otherwise read as a pattern, or to ignore case). */
export function literalPattern(text: string, ignoreCase = false): string {
  return `/${text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/${ignoreCase ? "i" : ""}`;
}
