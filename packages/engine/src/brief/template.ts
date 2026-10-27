// `aida brief init`: the skeleton the aida-understand skill fills in — every section with an HTML
// comment saying what goes there, readers from the config's roles, and "Things it keeps track of"
// started from `aida domain`.
import { stringify } from "yaml";
import { plainDomainList, type DomainModel } from "../domain/index.js";
import { BRIEF_PROMPTS, BRIEF_SECTIONS } from "./format.js";

export interface BriefTemplateInput {
  app?: string;
  /** Today, YYYY-MM-DD. */
  updated: string;
  /** Role id -> what to call it, from the config's `roles`. */
  roles?: { role: string; name: string }[];
  domain?: DomainModel;
}

export function briefTemplate(input: BriefTemplateInput): string {
  const app = input.app?.trim() || "";
  const readers = (input.roles && input.roles.length > 0 ? input.roles : [{ role: "", name: "" }]).map((r) => ({ role: r.role, name: r.name, job: "" }));
  const frontmatter = stringify({ app, updated: input.updated, readers }).trimEnd();
  const lines = [
    "---",
    frontmatter,
    "---",
    "",
    `# ${app || "App"} brief`,
    "",
    "<!-- Written by the aida-understand skill and read by every later skill, the help chat and the agent connector. Plain words (skills/references/style.md). Everything but \"Open questions\" is published with the help chat and agent connector: no real names, emails or phone numbers. Check with `aida brief check`. -->",
    "",
  ];
  for (const name of BRIEF_SECTIONS) {
    lines.push(`## ${name}`, "", `<!-- ${BRIEF_PROMPTS[name]} -->`, "");
    if (name === "Things it keeps track of" && input.domain) lines.push(plainDomainList(input.domain), "");
    if (name === "Words it uses") lines.push("| Term | Meaning | Not to be confused with |", "| --- | --- | --- |", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
