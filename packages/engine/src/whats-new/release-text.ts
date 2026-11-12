// The words of the release video (M48): its cards' text and spoken lines, its transcript and its
// block on the What's new page. Plain and short: what changed and where, nothing else.
import type { ReleaseCardText } from "../render/release-cut.js";
import { escapeMdxText } from "../pages/content.js";
import type { GeneratedBlock } from "../pages/markers.js";
import type { ChangeRule } from "./changes.js";

/** Key of the video's generated block on the What's new page. */
export const VIDEO_BLOCK_KEY = "whats-new-video";

/** One guide as it appears in the video. */
export interface ReleaseGuideText {
  id: string;
  title: string;
  rule: ChangeRule;
  /** Who it's for (`for:`), as the guide's own card shows it. */
  reader?: string;
  summary?: string;
  /** Page step numbers shown, in order, each with its title and narration. */
  steps: { n: number; title: string; say: string }[];
  /** Step count of the whole guide. */
  stepCount: number;
  /** Site path of the guide's page, e.g. `/how-do-i/add-an-entry`. */
  href: string;
  /** Rule "new": a guide that didn't exist at the base ref ("guide", the default), or one that
   * did but wasn't on the help site then ("published"). */
  newKind?: "guide" | "published";
  /** Its title at the base ref, when it had another id then (renamed). */
  renamedFrom?: string;
}

/** "step 3", "steps 3 and 4", "steps 3, 4 and 6". */
export function stepList(steps: number[]): string {
  if (steps.length === 1) return `step ${steps[0]}`;
  return `steps ${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** `office-staff` -> `Office staff`; a phrase is kept as written (render/timeline.ts's rule). */
export function readerLabel(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/\s/.test(v)) return v;
  const words = v.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `https://example.com/help/` -> `example.com/help` (the outro card's form). */
export function siteLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The video's name: "What's new: 2.4" or "What's new: 11 November 2026". */
export function releaseTitle(label: string): string {
  return `What's new: ${label}`;
}

/** `shown` guides are in the video out of `changed` that changed: when some were left out, the
 * card says so rather than counting only the ones shown. */
export function openingCard(label: string, release: string | undefined, shown: number, changed = shown): ReleaseCardText {
  const total = Math.max(changed, shown);
  const lead = `What's new${release ? ` in ${release}` : ""}: ${count(total, "guide")} changed`;
  return {
    id: "opening",
    eyebrow: "What's new",
    title: label,
    subtitle: shown === total ? `${capitalise(count(total, "guide"))} changed` : `${capitalise(count(total, "guide"))} changed, ${shown} in this video`,
    say: shown === total ? `${lead}.` : `${lead}; this video shows ${shown} of them.`,
  };
}

export function guideCard(g: ReleaseGuideText): ReleaseCardText {
  const shown = g.steps.map((s) => s.n);
  const base = { id: `guide-${g.id}`, title: g.title, ...(g.reader ? { reader: g.reader } : {}) };
  if (g.rule === "new") {
    // "New guide" only for a walkthrough that didn't exist at the base ref; one that did (or a
    // renamed one) is new on the help site, not new.
    if (g.newKind === "published") {
      return { ...base, eyebrow: "Now on the help site", subtitle: g.summary ?? "", facts: [count(g.stepCount, "step")], say: `Now on the help site: ${g.title}.` };
    }
    return { ...base, eyebrow: "New guide", subtitle: g.summary ?? "", facts: [count(g.stepCount, "step")], say: `New guide: ${g.title}.` };
  }
  if (g.rule === "screenshots") {
    const renamed = g.renamedFrom && g.renamedFrom !== g.title ? g.renamedFrom : undefined;
    return {
      ...base,
      eyebrow: "Changed",
      subtitle: `${capitalise(stepList(shown))}${renamed ? `; was "${renamed}"` : ""}`,
      facts: [`${shown.length} of ${count(g.stepCount, "step")}`],
      say: `${g.title}${renamed ? `, renamed from ${renamed}` : ""}: ${stepList(shown)} changed.`,
    };
  }
  return { ...base, eyebrow: "Updated", subtitle: g.summary ?? "", facts: [count(g.stepCount, "step")], say: `${g.title} has changed.` };
}

export function closingCard(site: string): ReleaseCardText {
  return { id: "closing", eyebrow: "That's what's new", title: site, subtitle: "Every guide is on the help site", say: `Every guide is at ${site}.` };
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** The transcript, in playback order: each card's line, each guide (with where it starts) and
 * each of its steps' narration exactly as the guide's own video speaks it. */
export function releaseTranscript(
  title: string,
  opening: ReleaseCardText,
  guides: { guide: ReleaseGuideText; card: ReleaseCardText; at: number }[],
  closing: ReleaseCardText | undefined,
): string {
  const section = (heading: string, body: string | undefined) => {
    const text = body?.trim();
    return text ? `${heading}\n\n${text}\n` : `${heading}\n`;
  };
  const parts = [`# ${title}`, "", section(`## ${opening.eyebrow}`, opening.say)];
  for (const { guide, card, at } of guides) {
    parts.push(section(`## ${guide.title} (${clock(at)})`, card.say));
    for (const s of guide.steps) parts.push(section(`### ${s.n}. ${s.title}`, s.say));
  }
  if (closing) parts.push(section(`## ${closing.eyebrow}`, closing.say));
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

const linkText = (s: string): string => escapeMdxText(s).replace(/[[\]]/g, "\\$&");

function guideLink(g: { title: string; href: string }): string {
  return `[${linkText(g.title)}](${g.href})`;
}

export interface LeftOutGuide {
  title: string;
  href: string;
  /** Steps left out; empty when the whole guide was. */
  steps: number[];
  /** True when only some of its steps were left out (the rest are in the video). */
  partly: boolean;
  /** Why: the caps or time budget ("short"), a different frame shape ("shape"), or steps only
   * another device's video has ("device"). */
  why: "short" | "shape" | "device";
}

const LEFT_OUT_LEAD: Record<LeftOutGuide["why"], string> = {
  short: "Also changed, left out to keep the video short",
  shape: "Also changed, not in this video because its video is a different shape (phone or desktop)",
  device: "Also changed, on steps this video doesn't show (they're for another device)",
};

/** Site URLs of the release video's files. */
export interface ReleaseVideoUrls {
  src: string;
  vtt: string;
  srt: string;
  chapters: string;
  transcript: string;
}

/**
 * The video's block on the What's new page: the same `VideoEmbed` the guide pages use (captions,
 * chapters, transcript disclosure), what's in it, and what was left out and why.
 * Attributes are JS string expressions, so no title can break the MDX.
 */
export function videoBlock(title: string, urls: ReleaseVideoUrls, shown: ReleaseGuideText[], leftOut: LeftOutGuide[]): GeneratedBlock {
  const attr = (name: string, value: string) => ` ${name}={${JSON.stringify(value)}}`;
  const lines = [
    `<VideoEmbed${attr("src", urls.src)}${attr("vtt", urls.vtt)}${attr("srt", urls.srt)}${attr("chapters", urls.chapters)}${attr("transcript", urls.transcript)}${attr("title", title)} />`,
  ];
  const what = (g: ReleaseGuideText) =>
    g.rule === "new" ? (g.newKind === "published" ? "now on the help site" : "new guide") : g.rule === "screenshots" ? stepList(g.steps.map((s) => s.n)) : "updated";
  lines.push("", `In this video: ${shown.map((g) => `${guideLink(g)} (${what(g)})`).join(", ")}.`);
  for (const why of ["short", "shape", "device"] as const) {
    const items = leftOut
      .filter((g) => g.why === why)
      .map((g) => (g.steps.length > 0 ? `${guideLink(g)} (${g.partly ? "also " : ""}${stepList(g.steps)})` : guideLink(g)));
    if (items.length > 0) lines.push("", `${LEFT_OUT_LEAD[why]}: ${items.join(", ")}.`);
  }
  return { key: VIDEO_BLOCK_KEY, content: lines.join("\n") };
}
