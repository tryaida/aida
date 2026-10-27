// Small, line-based frontmatter helpers for engine-written pages: read a page's frontmatter as
// data, and set/remove individual top-level keys without re-rendering the page (the index stage
// uses this to point a mirrored page's media at site URLs and to keep its `section` current).
import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// A lowercase keyword (`kind: section`) reads better bare; anything YAML could read as another
// type stays quoted.
const BARE_WORD = /^[a-z][a-z0-9-]*$/;
const YAML_KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n"]);

function yamlValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return BARE_WORD.test(value) && !YAML_KEYWORDS.has(value) ? value : yamlString(value);
}

/** A page's frontmatter as data (`{}` when it has none or it doesn't parse). */
export function readFrontmatter(raw: string): Record<string, unknown> {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return {};
  try {
    const data = parseYaml(match[2]) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The page text after its frontmatter block. */
export function bodyOf(raw: string): string {
  const match = FRONTMATTER_RE.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

export type FrontmatterValue = string | number | boolean | null | undefined;

/**
 * Sets (or, for `null`, removes) top-level frontmatter keys. A key already present is rewritten
 * in place; a new one is appended at the end. `undefined` leaves a key untouched. Single-line
 * values only — every key the engine writes is single-line. Returns `raw` unchanged when the
 * page has no frontmatter block.
 */
export function setFrontmatterFields(raw: string, fields: Record<string, FrontmatterValue>): string {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return raw;
  let lines = match[2].split(/\r?\n/);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\s|$)`);
    if (value === null) {
      lines = lines.filter((l) => !keyRe.test(l));
      continue;
    }
    const line = `${key}: ${yamlValue(value)}`;
    const at = lines.findIndex((l) => keyRe.test(l));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return `${match[1]}${lines.join("\n")}${match[3]}${raw.slice(match[0].length)}`;
}

/** Builds a complete frontmatter block from `fields` (skipping `undefined`/`null` values). */
export function frontmatterBlock(fields: Record<string, FrontmatterValue>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}
