// Alt text for a step's screenshot (M42a, decision 39): a plain-text description for someone who
// can't see the image — what screen it's on, what the reader does there, and what's numbered —
// so the page never ships an `alt` that only repeats the step heading (`buildStepBlock`'s old
// `![${title}](...)`, which a screen reader announces as no more than the heading it already
// read). Deterministic and markdown-free; `pages/content.ts` MDX-escapes the result before it
// goes into `![alt](...)`, same as every other walkthrough text on the page.
import type { ManifestStep } from "../capture/types.js";
import type { Device, Step } from "../walkthrough/types.js";
import { stepInstruction } from "../walkthrough/describe.js";
import { stripMarkdown } from "../index-search/build.js";

const MAX_CHARS = 250;

/** A plausible screen/dialog name for a step: the manifest's shortest `seen` entry that isn't one
 * of the callout labels or on-screen names the instruction already names (so the "screen" is
 * never just the thing being clicked), else the step's own title. `seen` mixes h1-h3 headings with
 * acted-on elements' accessible names (capture/seen.ts) with no tag telling them apart, so this is
 * a heuristic, not a guarantee of a true screen/dialog name — it only ever improves on the title. */
function screenName(step: Step, mStep: Pick<ManifestStep, "seen"> | undefined, named: Set<string>): string | undefined {
  const candidates = (mStep?.seen ?? [])
    .filter((s) => s.length <= 60 && !named.has(s.toLowerCase()) && /^[\p{Lu}\p{N}]/u.test(s) && !/[.!?]$/.test(s))
    .sort((a, b) => a.length - b.length);
  return candidates[0] ?? step.title?.trim() ?? undefined;
}

/** Names already spoken for in the instruction or drawn as a callout — kept out of the "screen"
 * guess above, and never repeated as the "what's highlighted" sentence either. */
function namedInStep(step: Step, mStep: Pick<ManifestStep, "targets"> | undefined): Set<string> {
  const names = [...(step.callouts ?? []).map((c) => c.label), ...(mStep?.targets ?? [])];
  return new Set(names.filter((n): n is string => Boolean(n?.trim())).map((n) => n.trim().toLowerCase()));
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Plain-text alt for a step's screenshot: one or two sentences — the screen (`screenName`), what
 * the reader does there (the step's own instruction, markdown stripped), and which callouts are
 * numbered on it, if any. `data` resolves `{{data}}` in the instruction exactly like the page body
 * does; the caller is expected to hand in a step already run through `displayWalkthrough` (so
 * `{{run.*}}` is already dropped too — walkthrough/display.ts).
 *
 * Never empty and never just the heading text: with no instruction and no callouts, it still
 * names the step number so a screen reader gets more than the heading it already announced.
 *
 * `device` says whose screen this is (M43b, decision 40) — unset or `"desktop"` reads exactly as
 * before; `"phone"` says so up front ("Phone screenshot of …"), since a reader switching between
 * a `<DeviceShots>` pair needs the alt text to tell the two images apart.
 */
export function stepAltText(
  step: Step,
  stepNumber: number,
  mStep?: Pick<ManifestStep, "seen" | "targets">,
  data?: Record<string, unknown>,
  device?: Device,
): string {
  const named = namedInStep(step, mStep);
  const screen = screenName(step, mStep, named);
  const instruction = stripMarkdown(stepInstruction(step, data)).trim();
  const calloutLabels = [...new Set((step.callouts ?? []).map((c) => c.label?.trim()).filter((l): l is string => Boolean(l)))];

  const noun = device === "phone" ? "Phone screenshot" : "Screenshot";
  const lead = screen ? `${noun} of ${screen}` : `${noun} for step ${stepNumber}`;
  let sentence = instruction ? `${lead}: ${lowerFirst(instruction)}` : lead;
  if (!/[.!?]$/.test(sentence)) sentence += ".";

  const out = [sentence];
  if (calloutLabels.length > 0) {
    out.push(`${calloutLabels.length === 1 ? "A numbered callout marks" : "Numbered callouts mark"} ${joinWords(calloutLabels)}.`);
  }
  return escapeForMarkdownImage(truncate(out.join(" "), MAX_CHARS));
}

/** Makes the text safe to sit inside `![alt](src)`: `[`/`]` close the alt early (and would also
 * defeat the PDF's own `!\[([^\]]*)\]` alt-text regexes — pdf/build.ts, qa/a11y.ts), so they're
 * swapped for parens rather than escaped (an escaped `\]` still breaks those regexes, which don't
 * know about backslash-escaping). A stray newline would break out of the single-line image
 * syntax entirely. The instruction, callout labels and headings this is built from are free text
 * (a walkthrough author's own words, an app's on-screen copy) with no promise against brackets. */
function escapeForMarkdownImage(s: string): string {
  return s.replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")")).replace(/\r?\n/g, " ");
}
