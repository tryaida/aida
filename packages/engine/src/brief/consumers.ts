// What the brief hands its readers outside the skills: a trimmed prefix for the help chat's
// system prompt, an overview for the agent connector's `get_app_overview` tool, and one intro
// sentence or two for the help site's home page. "Open questions" never leaves the repo.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { briefNotPublishableReason, checkBrief } from "./check.js";
import { briefAppName, briefReaders, normalizeHeading, parseBrief, sectionText, type BriefSection, type BriefSectionName, type ParsedBrief } from "./format.js";

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
  const perSection = Math.floor(maxChars / names.length) * 2;
  const parts: string[] = [];
  for (const name of names) {
    const text = sectionText(publishedSection(brief, name));
    if (hasContent(text)) parts.push(`## ${name}\n\n${trimText(text, perSection)}`);
  }
  if (parts.length === 0) return undefined;
  const head: string[] = [`# ${app ?? "The app"}`];
  const readers = briefReaders(brief).filter((r) => r.name.trim());
  if (withReaders && readers.length > 0) head.push(`Readers: ${readers.map((r) => (r.job.trim() ? `${r.name} (${r.job.trim().replace(/\.$/, "")})` : r.name)).join("; ")}.`);
  return trimText(`${head.join("\n\n")}\n\n${parts.join("\n\n")}`, maxChars);
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
}

export function briefArtifacts(brief: ParsedBrief | undefined): BriefArtifacts | undefined {
  if (!brief) return undefined;
  return { chat: briefForChat(brief), overview: briefOverview(brief), intro: briefIntro(brief) };
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
