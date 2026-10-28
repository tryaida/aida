// `app-brief.md` (build-plan.md M31, decision 33): what the app is for, who uses it, the things
// it keeps track of, its words, rules and rhythm — written once by the Understand step and read
// by every later skill, the help chat and the agent connector.
//
// Format: YAML frontmatter (`app`, `updated`, `readers: [{role, name, job}]`), then the H2
// sections in `BRIEF_SECTIONS`. HTML comments are prompts for whoever fills it in and are never
// passed on.
import { parse as parseYaml } from "yaml";

/** The required H2 sections, in order. */
export const BRIEF_SECTIONS = [
  "What it's for",
  "Who uses it",
  "Things it keeps track of",
  "Words it uses",
  "Rules that matter",
  "Rhythm",
  "Several ways to do one thing",
  "Open questions",
] as const;

/** Sections a brief may add, usually from an interview with the builder (`aida interview`,
 * decision 38): checked and published when present, never required. */
export const BRIEF_OPTIONAL_SECTIONS = ["Workflows", "Where people get stuck"] as const;

export type BriefSectionName = (typeof BRIEF_SECTIONS)[number] | (typeof BRIEF_OPTIONAL_SECTIONS)[number];

/** The prompt `aida brief init` writes under each section, as an HTML comment. One left as
 * written means the section was never looked at (`checkBrief` flags it). */
export const BRIEF_PROMPTS: Record<BriefSectionName, string> = {
  "What it's for":
    "Two or three short paragraphs. The first is shown on the help site's home page: what the app does and for whom, in one or two sentences. Then the real-world problem it solves and what life looked like before it.",
  "Who uses it":
    "One short paragraph per reader in the frontmatter: who they are, the job they're doing when they open the app, how often, and what they can and can't see or change.",
  "Things it keeps track of":
    "Started from `aida domain`. Rewrite in plain words: what each thing is to the people who use the app, how the things relate, and the states each moves through and what moves it on. Drop bookkeeping tables nobody sees.",
  "Words it uses":
    "The app's own words, spelled as the screen shows them. \"Not to be confused with\" catches near-synonyms and everyday words that mean something else here.",
  "Rules that matter":
    "Business rules a reader must know to avoid a mistake: what can't be undone, what's checked, limits, deadlines, money. One bullet each, with the reason.",
  Rhythm: "The daily, weekly or seasonal flow: what happens first, what happens in the busy period, what happens at the end.",
  "Several ways to do one thing":
    "Tasks that can be started from more than one screen. One bullet per task: the task, then each starting screen and when you'd use it, e.g. \"Record a payment: from the booking (one booking), from the attendee (all their bookings at once), from Payments (when the money arrives first)\". Write \"None found.\" if there are none.",
  Workflows:
    "Whole jobs from start to finish, across several tasks and anything done outside the app (an email, a bank transfer, a phone call). One bullet or short paragraph per job: who does it, the tasks in order, and the hand-offs between people.",
  "Where people get stuck":
    "The mistakes people make and the questions they ask most, one bullet each: what goes wrong, then how to put it right or avoid it.",
  "Open questions":
    "What you couldn't work out from the repo, for the person to answer before planning. Move each answer into the section it belongs in and delete the question; this section is never published.",
};

export interface BriefReader {
  role: string;
  name: string;
  job: string;
  /** Optional profile, usually from an interview: the devices they use the app on. */
  devices?: BriefDevice[];
  /** How at home they are with apps like this one: pitches how much each page explains. */
  comfort?: BriefComfort;
  /** How often they use it, in plain words ("every day in season", "once a year"). */
  frequency?: string;
  /** Where they are and what's going on when they open it ("at the venue, between races"). */
  context?: string;
}

export const BRIEF_DEVICES = ["phone", "tablet", "desktop"] as const;
export type BriefDevice = (typeof BRIEF_DEVICES)[number];
/** `new`: first app of its kind, explain every step; `some`: has used similar apps; `confident`:
 * wants the short version. */
export const BRIEF_COMFORT = ["new", "some", "confident"] as const;
export type BriefComfort = (typeof BRIEF_COMFORT)[number];

export interface BriefFrontmatter {
  app?: unknown;
  updated?: unknown;
  readers?: unknown;
  [key: string]: unknown;
}

export interface BriefSection {
  /** The heading as written. */
  name: string;
  /** Body text, HTML comments kept (see `sectionText`). */
  body: string;
}

export interface ParsedBrief {
  frontmatter?: BriefFrontmatter;
  frontmatterError?: string;
  /** Text before the first H2 (usually the H1). */
  preamble: string;
  sections: BriefSection[];
}

/** Normalises a heading for matching: case, curly apostrophes and spacing don't matter. */
export function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

export function parseBrief(text: string): ParsedBrief {
  let body = text.replace(/^﻿/, "");
  let frontmatter: BriefFrontmatter | undefined;
  let frontmatterError: string | undefined;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fm) {
    try {
      const data = parseYaml(fm[1]) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) frontmatter = data as BriefFrontmatter;
      else frontmatterError = "frontmatter is not a YAML mapping";
    } catch (err) {
      frontmatterError = `frontmatter is not valid YAML: ${(err as Error).message.split("\n")[0]}`;
    }
    body = body.slice(fm[0].length);
  }

  const sections: BriefSection[] = [];
  const preamble: string[] = [];
  let current: BriefSection | undefined;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h2 = !fenced ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h2) {
      current = { name: h2[1].trim(), body: "" };
      sections.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
    else preamble.push(line);
  }
  for (const s of sections) s.body = s.body.replace(/\s+$/, "");
  return { frontmatter, frontmatterError, preamble: preamble.join("\n").trim(), sections };
}

/** A section's text with prompts (HTML comments) removed and blank runs collapsed. */
export function sectionText(section: BriefSection | undefined): string {
  if (!section) return "";
  return stripHtmlComments(section.body)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Finds a section by name: exact (normalised), then a heading starting with the query, then one
 * containing it — so `--section words` finds "Words it uses".
 */
export function findSection(brief: ParsedBrief, query: string): BriefSection | undefined {
  const q = normalizeHeading(query);
  if (!q) return undefined;
  return (
    brief.sections.find((s) => normalizeHeading(s.name) === q) ??
    brief.sections.find((s) => normalizeHeading(s.name).startsWith(q)) ??
    brief.sections.find((s) => normalizeHeading(s.name).includes(q))
  );
}

/** The frontmatter's readers that have all three fields as strings, with only the profile fields
 * that are well formed (`checkBrief` warns about the rest). */
export function briefReaders(brief: ParsedBrief): BriefReader[] {
  const list = brief.frontmatter?.readers;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (r): r is BriefReader =>
        Boolean(r) && typeof r === "object" && typeof (r as BriefReader).role === "string" && typeof (r as BriefReader).name === "string" && typeof (r as BriefReader).job === "string",
    )
    .map((r) => {
      const reader: BriefReader = { role: r.role, name: r.name, job: r.job };
      const devices = Array.isArray(r.devices) ? r.devices.filter((d): d is BriefDevice => (BRIEF_DEVICES as readonly unknown[]).includes(d)) : [];
      if (devices.length > 0) reader.devices = devices;
      if ((BRIEF_COMFORT as readonly unknown[]).includes(r.comfort)) reader.comfort = r.comfort;
      if (typeof r.frequency === "string" && r.frequency.trim()) reader.frequency = r.frequency.trim();
      if (typeof r.context === "string" && r.context.trim()) reader.context = r.context.trim();
      return reader;
    });
}

/** The app's name from the frontmatter, when it's a non-empty string. */
export function briefAppName(brief: ParsedBrief): string | undefined {
  const app = brief.frontmatter?.app;
  return typeof app === "string" && app.trim() ? app.trim() : undefined;
}
