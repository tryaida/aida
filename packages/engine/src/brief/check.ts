// `aida brief check`: the brief has its frontmatter and every section filled, a glossary table,
// and no real-looking emails or phone numbers (the same scan QA runs on pages, src/qa/pii.ts).
import { scanEmails, scanPhones } from "../qa/pii.js";
import { BRIEF_PROMPTS, BRIEF_SECTIONS, normalizeHeading, parseBrief, sectionText, stripHtmlComments, type ParsedBrief } from "./format.js";

export interface BriefIssue {
  /** The section it's about, when there is one. */
  section?: string;
  message: string;
  /** Warnings that stop `aida build` publishing the brief: a real-looking email or phone number,
   * or a section's template prompt left as written. */
  kind?: "personal-data" | "prompt";
}

export interface BriefSectionStatus {
  name: string;
  present: boolean;
  filled: boolean;
  chars: number;
}

export interface BriefCheckResult {
  ok: boolean;
  errors: BriefIssue[];
  warnings: BriefIssue[];
  sections: BriefSectionStatus[];
  /** Characters a reader of the whole brief loads (prompts excluded). */
  chars: number;
}

/** Every skill loads the brief, and the help chat sends part of it with every question. */
export const BRIEF_SIZE_WARN_CHARS = 16_000;

/** Sections that may say "None" and still count as filled. */
const MAY_BE_NONE = new Set(["Several ways to do one thing", "Open questions"]);
const PLACEHOLDER = /\b(TODO|TBD|FIXME)\b/;

export function checkBrief(text: string): BriefCheckResult {
  const brief = parseBrief(text);
  const errors: BriefIssue[] = [];
  const warnings: BriefIssue[] = [];

  checkFrontmatter(brief, errors);

  const sections: BriefSectionStatus[] = [];
  for (const name of BRIEF_SECTIONS) {
    const matches = brief.sections.filter((s) => normalizeHeading(s.name) === normalizeHeading(name));
    const body = sectionText(matches[0]);
    const filled = body.length > 0 && (MAY_BE_NONE.has(name) || !/^none\.?$/i.test(body));
    sections.push({ name, present: matches.length > 0, filled, chars: body.length });
    if (matches.length === 0) errors.push({ section: name, message: `missing section "## ${name}"` });
    else if (!filled && name === "Open questions") warnings.push({ section: name, message: 'empty; write "None." when nothing is left to ask' });
    else if (!filled) errors.push({ section: name, message: `"${name}" is empty${MAY_BE_NONE.has(name) ? ' (write "None found." if so)' : ""}` });
    if (matches.length > 1) warnings.push({ section: name, message: `"${name}" appears ${matches.length} times; only the first is read` });
    if (filled && PLACEHOLDER.test(body)) warnings.push({ section: name, message: `"${name}" still has a ${PLACEHOLDER.exec(body)![1]}` });
    if (matches[0] && matches[0].body.includes(`<!-- ${BRIEF_PROMPTS[name]} -->`) && name !== "Open questions") {
      warnings.push({ section: name, kind: "prompt", message: `"${name}" still has the template's prompt; replace it once the section is written` });
    }
  }

  const words = brief.sections.find((s) => normalizeHeading(s.name) === normalizeHeading("Words it uses"));
  if (words && sectionText(words)) checkGlossary(sectionText(words), errors, warnings);

  // Personal data: the brief is published (help chat, agent connector), so the same rules as pages.
  const visible = stripHtmlComments(text);
  for (const problem of [...scanEmails(visible), ...scanPhones(visible)]) {
    warnings.push({ kind: "personal-data", message: `${problem} (use example.com and the reserved fictional ranges, references/safety.md)` });
  }

  const chars = sections.reduce((n, s) => n + s.chars, 0);
  if (chars > BRIEF_SIZE_WARN_CHARS) {
    warnings.push({ message: `${chars} characters (about ${Math.round(chars / 4)} tokens); keep it under ${BRIEF_SIZE_WARN_CHARS} so every skill can afford to load it` });
  }

  return { ok: errors.length === 0, errors, warnings, sections, chars };
}

/** Why `aida build` won't publish this brief (to the help chat, agent connector and home page),
 * or `undefined` when it may: no check errors, no personal data, no template prompts left. */
export function briefNotPublishableReason(result: BriefCheckResult): string | undefined {
  if (result.errors.length > 0) return `aida brief check finds ${result.errors.length} error(s), e.g. ${result.errors[0].message}`;
  const pii = result.warnings.filter((w) => w.kind === "personal-data");
  if (pii.length > 0) return `it has ${pii.length} real-looking email(s) or phone number(s)`;
  const prompts = result.warnings.filter((w) => w.kind === "prompt");
  if (prompts.length > 0) return `${prompts.length} section(s) still have the template's prompt (${prompts.map((w) => w.section).join(", ")})`;
  return undefined;
}

function checkFrontmatter(brief: ParsedBrief, errors: BriefIssue[]): void {
  if (brief.frontmatterError) {
    errors.push({ message: brief.frontmatterError });
    return;
  }
  const fm = brief.frontmatter;
  if (!fm) {
    errors.push({ message: "no YAML frontmatter (app, updated, readers)" });
    return;
  }
  if (typeof fm.app !== "string" || !fm.app.trim()) errors.push({ message: "frontmatter `app` must be the app's name" });
  const updated = fm.updated instanceof Date ? fm.updated.toISOString().slice(0, 10) : fm.updated;
  if (typeof updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) errors.push({ message: "frontmatter `updated` must be a date, YYYY-MM-DD" });
  if (!Array.isArray(fm.readers) || fm.readers.length === 0) {
    errors.push({ message: "frontmatter `readers` must list at least one reader: {role, name, job}" });
    return;
  }
  fm.readers.forEach((r, i) => {
    const reader = (r ?? {}) as Record<string, unknown>;
    const missing = ["role", "name", "job"].filter((k) => typeof reader[k] !== "string" || !(reader[k] as string).trim());
    if (missing.length > 0) errors.push({ message: `readers[${i}] is missing ${missing.join(", ")}` });
  });
}

/** "Words it uses" holds a table: term | meaning | not to be confused with. */
function checkGlossary(body: string, errors: BriefIssue[], warnings: BriefIssue[]): void {
  const section = "Words it uses";
  const rows = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const header = rows[0];
  if (!header || !/term/i.test(header[0] ?? "") || !/meaning/i.test(header[1] ?? "")) {
    errors.push({ section, message: "needs a table: | Term | Meaning | Not to be confused with |" });
    return;
  }
  const data = rows.slice(1).filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
  if (data.length === 0) errors.push({ section, message: "the glossary table has no rows" });
  for (const r of data) {
    if (!r[0] || !r[1]) warnings.push({ section, message: `glossary row "${r.join(" | ")}" needs a term and a meaning` });
  }
}
