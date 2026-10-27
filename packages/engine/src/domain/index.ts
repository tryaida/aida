// `aida domain`: the app's domain model from its database schema (build-plan.md M31).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDrizzle } from "./drizzle.js";
import { findSchemaSources, type FoundSource } from "./find.js";
import { buildModel } from "./model.js";
import { parsePrisma } from "./prisma.js";
import { parseSqlMigrations } from "./sql.js";
import type { DomainModel, DomainSourceKind, RawSchema } from "./types.js";

export * from "./types.js";
export { findSchemaSources, type FoundSource } from "./find.js";
export { findEntity, linkCount, rankEntities } from "./model.js";
export { formatDomain, formatEntity, describeEntityPlainly, plainDomainList, keyColumns, isNoiseColumn } from "./format.js";
export { entityLabel, columnLabel, plural, singular } from "./text.js";

export interface BuildDomainOptions {
  /** Read only this kind of source (default: the first found of drizzle, prisma, sql). */
  source?: DomainSourceKind;
}

export type BuildDomainResult = { ok: true; model: DomainModel; found: FoundSource[] } | { ok: false; error: string; found: FoundSource[] };

function parse(repo: string, found: FoundSource): RawSchema {
  const files = found.files.map((rel) => ({ path: rel, text: readFileSync(join(repo, rel), "utf8") }));
  if (found.kind === "drizzle") return parseDrizzle(files);
  if (found.kind === "prisma") return parsePrisma(files.map((f) => f.text).join("\n"));
  return parseSqlMigrations(files);
}

/** Reads the repo's schema statically and builds its domain model. A source that yields no
 * tables falls through to the next one. */
export function buildDomain(repo: string, opts: BuildDomainOptions = {}): BuildDomainResult {
  const found = findSchemaSources(repo);
  const candidates = opts.source ? found.filter((f) => f.kind === opts.source) : found;
  for (const source of candidates) {
    const raw = parse(repo, source);
    if (raw.tables.length > 0) return { ok: true, model: buildModel(raw, { kind: source.kind, files: source.files }), found };
  }
  const what = opts.source ? `no ${opts.source} schema with tables` : "no database schema (Drizzle, Prisma or SQL migrations)";
  return { ok: false, error: `${what} found in ${repo}`, found };
}
