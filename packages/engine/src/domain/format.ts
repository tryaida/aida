// Text renderings of the domain model: a compact summary (one line per entity, most-connected
// first, noise columns and foreign keys left out), one entity in full, and the plain-words lines
// `aida brief init` puts under "Things it keeps track of".
import { linkCount, rankEntities } from "./model.js";
import { columnLabel, plural } from "./text.js";
import type { DomainColumn, DomainEntity, DomainModel } from "./types.js";

const NOISE = /^(id|uuid|created_?at|updated_?at|inserted_?at|modified_?at|created_?on|updated_?on|date_?created|date_?updated|version|row_?version)$/i;
const MAX_KEY_COLUMNS = 6;
const MAX_VALUES = 6;

/** Bookkeeping columns a reader never thinks about: ids and created/updated stamps. */
export function isNoiseColumn(c: DomainColumn): boolean {
  return Boolean(c.primaryKey) || NOISE.test(c.name);
}

/** Columns worth naming: not noise, not a foreign key to another entity (shown as a link). */
export function keyColumns(model: DomainModel, e: DomainEntity): DomainColumn[] {
  const fkColumns = new Set(e.belongsTo.map((l) => l.column));
  return e.columns.filter((c) => !isNoiseColumn(c) && !fkColumns.has(c.name));
}

function values(model: DomainModel, c: DomainColumn, sep: string, max = MAX_VALUES): string | undefined {
  const list = c.enum ? model.enums[c.enum] : undefined;
  if (!list || list.length === 0) return undefined;
  const shown = list.slice(0, max).join(sep);
  return list.length > max ? `${shown}${sep}…+${list.length - max}` : shown;
}

function labelOf(model: DomainModel, name: string): string {
  return model.entities.find((e) => e.name === name)?.label ?? name;
}

function uniqueLabels(model: DomainModel, links: { entity: string }[], many: boolean): string[] {
  const labels = [...new Set(links.map((l) => l.entity))].map((n) => labelOf(model, n));
  return many ? labels.map(plural) : labels;
}

function entityLine(model: DomainModel, e: DomainEntity): string {
  const keys = keyColumns(model, e);
  // States are the point of the summary: enum columns always make the cut, in schema order.
  const room = Math.max(0, MAX_KEY_COLUMNS - keys.filter((c) => c.enum).length);
  const plainShown = new Set(keys.filter((c) => !c.enum).slice(0, room));
  const cols = keys.filter((c) => c.enum || plainShown.has(c)).map((c) => {
    const v = values(model, c, "|");
    // The state a new record starts in is part of the lifecycle: `status: pending|paid (default pending)`.
    const d = c.enum && c.default !== undefined ? ` (default ${c.default})` : "";
    return v ? `${c.name}: ${v}${d}` : c.name;
  });
  if (keys.length > cols.length) cols.push(`+${keys.length - cols.length}`);
  const links: string[] = [];
  if (e.belongsTo.length > 0) links.push(`belongs to ${uniqueLabels(model, e.belongsTo, false).join(", ")}`);
  if (e.hasMany.length > 0) links.push(`has many ${uniqueLabels(model, e.hasMany, true).join(", ")}`);
  return `${e.label} (${e.name}): ${cols.join(", ") || "-"}${links.length ? ` — ${links.join("; ")}` : ""}`;
}

function sourceLine(model: DomainModel): string {
  const files = model.source.files;
  const where = files.length <= 2 ? files.join(", ") : `${files.length} files, ${files[0]} … ${files[files.length - 1]}`;
  const linkTotal = model.entities.reduce((n, e) => n + e.belongsTo.length, 0);
  return `domain from ${model.source.kind} (${where}): ${model.entities.length} entities, ${Object.keys(model.enums).length} enums, ${linkTotal} links`;
}

/** The default `aida domain` output: one line per entity, kept short for a whole app. */
export function formatDomain(model: DomainModel): string {
  const lines = [sourceLine(model), ""];
  for (const e of rankEntities(model.entities)) lines.push(entityLine(model, e));
  const used = new Set(model.entities.flatMap((e) => e.columns.map((c) => c.enum).filter(Boolean)));
  const unused = Object.entries(model.enums).filter(([name]) => !used.has(name));
  if (unused.length > 0) {
    lines.push("");
    lines.push(`enums no column uses: ${unused.map(([name, v]) => `${name} (${v.slice(0, 4).join("|")}${v.length > 4 ? "|…" : ""})`).join(", ")}`);
  }
  lines.push("");
  lines.push("--entity <name> shows every column; --json gives the structured model.");
  return lines.join("\n");
}

/** One entity in full: links, then every column with its type, reference and values. */
export function formatEntity(model: DomainModel, e: DomainEntity): string {
  const lines = [`${e.label} (${e.name})`];
  if (e.belongsTo.length > 0) lines.push(`  belongs to: ${e.belongsTo.map((l) => `${labelOf(model, l.entity)} (${l.column})`).join(", ")}`);
  if (e.hasMany.length > 0) lines.push(`  has many: ${e.hasMany.map((l) => `${plural(labelOf(model, l.entity))} (${l.entity}.${l.column})`).join(", ")}`);
  lines.push("  columns:");
  for (const c of e.columns) {
    const parts = [`    ${c.name} ${c.type}`];
    if (c.primaryKey) parts.push("primary key");
    if (c.ref) parts.push(`-> ${c.ref}`);
    const v = values(model, c, " | ", 50);
    if (v) parts.push(`: ${v}`);
    if (c.default !== undefined) parts.push(`(default ${c.default})`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

/** One plain-words bullet for the brief: "**Booking**: belongs to an Event; has many Payments.
 * Details: seats, notes. Status: pending, confirmed or cancelled." */
export function describeEntityPlainly(model: DomainModel, e: DomainEntity): string {
  const parts: string[] = [];
  const belongs = uniqueLabels(model, e.belongsTo, false);
  const many = uniqueLabels(model, e.hasMany, true);
  const rel: string[] = [];
  if (belongs.length > 0) rel.push(`belongs to ${joinWords(belongs.map(withArticle))}`);
  if (many.length > 0) rel.push(`has many ${joinWords(many)}`);
  parts.push(rel.length > 0 ? `${rel.join("; ")}.` : "stands on its own.");
  const keys = keyColumns(model, e);
  const states = keys.filter((c) => c.enum);
  const details = keys.filter((c) => !c.enum).slice(0, 5).map((c) => columnLabel(c.name));
  if (details.length > 0) parts.push(`Details: ${details.join(", ")}.`);
  for (const c of states.slice(0, 3)) {
    const list = model.enums[c.enum!] ?? [];
    const starts = c.default !== undefined && list.includes(c.default) ? ` (new ones start as ${c.default})` : "";
    parts.push(`${capitalize(columnLabel(c.name))}: ${joinWords(list.slice(0, 8), "or")}${list.length > 8 ? " (and more)" : ""}${starts}.`);
  }
  return `- **${e.label}**: ${parts.join(" ")}`;
}

/** The plain-words list `aida brief init` starts "Things it keeps track of" with: the most
 * connected entities only. Standalone and minor tables are left out, not listed: the brief is
 * published, and a table name nobody sees (credentials, tokens) has no place in it. */
export function plainDomainList(model: DomainModel, max = 15): string {
  return rankEntities(model.entities)
    .filter((e) => linkCount(e) > 0)
    .slice(0, max)
    .map((e) => describeEntityPlainly(model, e))
    .join("\n");
}

function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function joinWords(words: string[], last = "and"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
