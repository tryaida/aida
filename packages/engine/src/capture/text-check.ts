import type { Locator } from "playwright";
import { textPattern } from "../walkthrough/text-pattern.js";

/** Whitespace collapsed and trimmed, the way Playwright's toHaveText/toContainText compare. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `actual` matches an expect's `text` (M38): contains it (`toContainText`), or with
 * `exact` equals it (`toHaveText`), both after whitespace is collapsed. A `"/pattern/"` (or
 * `"/pattern/i"`) value is a regular expression, checked when the walkthrough loaded
 * (walkthrough/text-pattern.ts): searched for, or with `exact` matched against the whole text.
 */
export function textMatches(actual: string, wanted: string, exact: boolean): boolean {
  const got = normaliseText(actual);
  const pattern = textPattern(wanted);
  if (pattern) {
    const re = new RegExp(exact ? `^(?:${pattern.source})$` : pattern.source, pattern.flags);
    return re.test(got);
  }
  const want = normaliseText(wanted);
  return exact ? got === want : got.includes(want);
}

/**
 * Waits until `loc`'s text matches (see `textMatches`), polling like Playwright's web-first
 * assertions. Reads `textContent`, as toHaveText/toContainText do by default: the DOM's text,
 * hidden children included and CSS `text-transform` not applied. Throws with what the element showed instead when `timeoutMs` runs out.
 */
export async function waitForText(loc: Locator, wanted: string, exact: boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    last = (await loc.textContent({ timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) }).catch(() => last)) ?? "";
    if (textMatches(last, wanted, exact)) return normaliseText(last);
    if (Date.now() >= deadline) {
      const shown = normaliseText(last);
      throw new Error(
        `expected text ${exact ? "to be exactly" : "to contain"} ${JSON.stringify(wanted)} but it shows ${JSON.stringify(shown.length > 200 ? `${shown.slice(0, 200)}…` : shown)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
