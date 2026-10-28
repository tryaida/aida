// What the brief hands its readers outside the skills: a trimmed prefix for the help chat's
// system prompt, an overview for the agent connector's `get_app_overview` tool, and one intro
// sentence or two for the help site's home page. "Open questions" never leaves the repo.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { briefNotPublishableReason, checkBrief } from "./check.js";
import { escapeMdxText } from "../pages/content.js";
import { BRIEF_OPTIONAL_SECTIONS, briefAppName, briefReaders, normalizeHeading, parseBrief, sectionText, type BriefReader, type BriefSection, type BriefSectionName, type ParsedBrief } from "./format.js";

export const DEFAULT_BRIEF_FILE = "app-brief.md";

/** Sections the help chat gets: enough to know the app, its people and its words. */
export const CHAT_BRIEF_SECTIONS: BriefSectionName[] = ["What it's for", "Who uses it", "Words it uses"];
/** ~1,500 tokens: the chat sends this with every question. */
export const CHAT_BRIEF_MAX_CHARS = 6_000;

/** Sections the agent connector returns: everything but "Open questions". */
export const OVERVIEW_SECTIONS: BriefSectionName[] = [
  "What it's for",
  "Who uses it",
  "Things it keeps track of",
  "Words it uses",
  "Rules that matter",
  "Rhythm",
  "Several ways to do one thing",
  "Workflows",
  "Where people get stuck",
];
export const OVERVIEW_MAX_CHARS = 16_000;

const INTRO_MAX_CHARS = 280;

/** `config.brief`, else `app-brief.md`, next to the config file. */
export function briefPath(config: { configDir: string; brief?: string }): string {
  const file = config.brief ?? DEFAULT_BRIEF_FILE;
  return isAbsolute(file) ? file : join(config.configDir, file);
}

/** The parsed brief, or `undefined` when there's no file. */
export function loadBrief(file: string): ParsedBrief | undefined {
  if (!existsSync(file)) return undefined;
  return parseBrief(readFileSync(file, "utf8"));
}

/** Cuts `text` to `max` characters at a line (else word) boundary, marking the cut. */
export function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const newline = slice.lastIndexOf("\n");
  const cut = newline > max * 0.6 ? newline : slice.lastIndexOf(" ");
  return `${slice.slice(0, cut > 0 ? cut : max).trimEnd()}\n…`;
}

/** False for an unfilled section: nothing, or only a table's header and separator. */
function hasContent(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 0 && !(lines.length <= 2 && lines.every((l) => l.trim().startsWith("|")));
}

/** A published section by its exact heading (normalised), never a fuzzy match: a heading that
 * only resembles one ("Open questions about rhythm") must not leak. */
function publishedSection(brief: ParsedBrief, name: BriefSectionName): BriefSection | undefined {
  if (name === "Open questions") return undefined;
  return brief.sections.find((s) => normalizeHeading(s.name) === normalizeHeading(name));
}

function compose(brief: ParsedBrief, names: BriefSectionName[], maxChars: number, withReaders: boolean): string | undefined {
  const app = briefAppName(brief);
  // Optional sections saying "None." have nothing to hand on.
  const filled = names
    .map((name) => ({ name, text: sectionText(publishedSection(brief, name)) }))
    .filter(({ name, text }) => hasContent(text) && !((BRIEF_OPTIONAL_SECTIONS as readonly string[]).includes(name) && /^none( found)?\.?$/i.test(text)));
  // Shared between the sections that have something, so a brief without the optional sections
  // keeps the room it had before they existed.
  const perSection = Math.floor(maxChars / Math.max(filled.length, 1)) * 2;
  const parts = filled.map(({ name, text }) => `## ${name}\n\n${trimText(text, perSection)}`);
  if (parts.length === 0) return undefined;
  const head: string[] = [`# ${app ?? "The app"}`];
  const readers = briefReaders(brief).filter((r) => r.name.trim());
  if (withReaders && readers.length > 0) head.push(`Readers: ${readers.map(readerLine).join("; ")}.`);
  return trimText(`${head.join("\n\n")}\n\n${parts.join("\n\n")}`, maxChars);
}

/** "an organiser (run the club's races; on phone, every week in season)": the job, then any
 * profile the brief gives (devices, how often). */
function readerLine(r: BriefReader): string {
  const job = r.job.trim().replace(/\.$/, "");
  const profile = [r.devices && r.devices.length > 0 ? `on ${r.devices.join(" or ")}` : "", r.frequency?.replace(/\.$/, "") ?? ""].filter(Boolean);
  const detail = [job, profile.join(", ")].filter(Boolean).join("; ");
  return detail ? `${r.name} (${detail})` : r.name;
}

/** The help chat's stable prefix: what the app is for, who uses it and its words. */
export function briefForChat(brief: ParsedBrief): string | undefined {
  return compose(brief, CHAT_BRIEF_SECTIONS, CHAT_BRIEF_MAX_CHARS, false);
}

/** The agent connector's overview (Markdown): readers, then every published section. */
export function briefOverview(brief: ParsedBrief): string | undefined {
  return compose(brief, OVERVIEW_SECTIONS, OVERVIEW_MAX_CHARS, true);
}

/** What `aida build` hands on from the brief (build/index-stage.ts `appBrief`), as plain strings
 * so the index stage, which the help app's routes bundle, never imports this module. */
export interface BriefArtifacts {
  chat?: string;
  overview?: string;
  intro?: string;
  /** Help-site pages built from the brief (`briefPages`): the glossary, the rules, what the app
   * is for. Ready-to-write MDX bodies, so the index stage only places them. */
  pages?: BriefPage[];
}

/** One help-site page built from the brief. `category` is a library category slug
 * (`words-we-use`, ...); the page goes to `<category>/<slug>/index.mdx`. */
export interface BriefPage {
  category: string;
  slug: string;
  title: string;
  description: string;
  /** MDX body (no frontmatter), already escaped. */
  body: string;
  /** Sorts before the category's other pages (an overview page). */
  first?: boolean;
}

export function briefArtifacts(brief: ParsedBrief | undefined): BriefArtifacts | undefined {
  if (!brief) return undefined;
  const pages = briefPages(brief);
  return { chat: briefForChat(brief), overview: briefOverview(brief), intro: briefIntro(brief), ...(pages.length > 0 ? { pages } : {}) };
}

/** What `aida build` publishes from the brief at `file`: nothing when there's no brief, and
 * nothing (with the reason, for a build warning) when it fails `aida brief check`, holds personal
 * data or still has template prompts. */
export function briefForBuild(file: string): { artifacts?: BriefArtifacts; skipped?: string } {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const skipped = briefNotPublishableReason(checkBrief(text));
  if (skipped) return { skipped };
  return { artifacts: briefArtifacts(parseBrief(text)) };
}

/** The home page intro: the first paragraph of "What it's for", as plain text, cut at a
 * sentence when long. */
export function briefIntro(brief: ParsedBrief): string | undefined {
  const text = sectionText(publishedSection(brief, "What it's for"));
  const first = text.split(/\n\s*\n/)[0]?.trim();
  if (!first || /^[-*|#>]/.test(first)) return undefined;
  const plain = first
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= INTRO_MAX_CHARS) return plain;
  const sentences = plain.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trim().length > INTRO_MAX_CHARS) break;
    out += s;
  }
  return out.trim() || `${plain.slice(0, INTRO_MAX_CHARS - 1).replace(/\s+\S*$/, "")}…`;
}

/** Rows of the "Words it uses" table: term, meaning, not to be confused with. */
export function glossaryRows(brief: ParsedBrief): { term: string; meaning: string; notConfusedWith?: string }[] {
  const text = sectionText(publishedSection(brief, "Words it uses"));
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  return rows
    .slice(1)
    .filter((r) => !r.every((c) => /^:?-+:?$/.test(c)))
    .filter((r) => r[0] && r[1])
    .map((r) => ({ term: r[0], meaning: r[1], ...(r[2] && !/^(-|—|n\/a|none)$/i.test(r[2]) ? { notConfusedWith: r[2] } : {}) }));
}

/** The bullets of a section, one string each (continuation lines joined). */
function bullets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) out.push(m[1].trim());
    else if (line.trim() && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out.filter(Boolean);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?:)]$/.test(t) ? t : `${t}.`;
}

/** "A survey or vote" -> "a survey or vote": only a leading article or pronoun, so the app's own
 * words ("Close", "Yes", "Pro") keep their capitals. */
function lowerFirst(text: string): string {
  return /^(A|An|The|Any|Each|Every|One|Someone|Something)\b/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * Help-site pages from the brief's published sections ("Open questions" never): a glossary in
 * Words we use, the rules in Troubleshooting and FAQ as "Good to know", and "What <app> is for"
 * at the top of Getting started. A section with nothing in it gives no page.
 */
export function briefPages(brief: ParsedBrief): BriefPage[] {
  const app = briefAppName(brief);
  const pages: BriefPage[] = [];

  const words = glossaryRows(brief);
  if (words.length > 0) {
    const body = words
      .map((w) => {
        // One short block per term: the meaning, then what it isn't, in the same paragraph.
        const meaning = sentence(escapeMdxText(w.meaning));
        const not = w.notConfusedWith ? ` *Not the same as ${lowerFirst(sentence(escapeMdxText(w.notConfusedWith)))}*` : "";
        return `## ${escapeMdxText(w.term)}\n\n${meaning}${not}`;
      })
      .join("\n\n");
    pages.push({
      category: "words-we-use",
      slug: "glossary",
      title: app ? `Words ${app} uses` : "Glossary",
      description: "What the words you'll see on screen mean, and what they don't.",
      body,
    });
  }

  const rules = bullets(sectionText(publishedSection(brief, "Rules that matter")));
  if (rules.length > 0) {
    pages.push({
      category: "troubleshooting-and-faq",
      slug: "good-to-know",
      title: "Good to know",
      description: app ? `Rules worth knowing before you use ${app}, and why they matter.` : "Rules worth knowing before you start, and why they matter.",
      body: rules.map((r) => `- ${escapeMdxText(r)}`).join("\n"),
    });
  }

  const stuck = bullets(sectionText(publishedSection(brief, "Where people get stuck")));
  if (stuck.length > 0) {
    pages.push({
      category: "troubleshooting-and-faq",
      slug: "common-problems",
      title: "Common problems",
      description: "Mistakes people often make, and how to put them right.",
      body: stuck.map((r) => `- ${escapeMdxText(r)}`).join("\n"),
    });
  }

  const forText = sectionText(publishedSection(brief, "What it's for"));
  const whoText = sectionText(publishedSection(brief, "Who uses it"));
  if (hasContent(forText)) {
    const parts = [escapeMdxText(forText.trim())];
    if (hasContent(whoText)) parts.push(`## Who uses it\n\n${escapeMdxText(whoText.trim())}`);
    pages.push({
      category: "getting-started",
      slug: `what-${slugify(app ?? "the-app")}-is-for`,
      title: app ? `What ${app} is for` : "What the app is for",
      description: app ? `What ${app} does, and who uses it.` : "What the app does, and who uses it.",
      body: parts.join("\n\n"),
      first: true,
    });
  }
  return pages;
}
