// Turns a schema reader's raw tables into the domain model: foreign keys become links seen from
// both ends ("Booking belongs to Event", "Event has many Bookings"), and only enums some column
// uses, or that a database type declares, are kept.
import { entityLabel } from "./text.js";
import type { DomainEntity, DomainModel, DomainSource, RawSchema } from "./types.js";

export function buildModel(raw: RawSchema, source: DomainSource): DomainModel {
  const names = new Set(raw.tables.map((t) => t.name));
  const entities = new Map<string, DomainEntity>();
  for (const t of raw.tables) {
    entities.set(t.name, {
      name: t.name,
      label: entityLabel(t.name),
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.ref ? { ref: `${c.ref.table}.${c.ref.column}` } : {}),
        ...(c.enum ? { enum: c.enum } : {}),
        ...(c.primaryKey ? { primaryKey: true as const } : {}),
      })),
      belongsTo: [],
      hasMany: [],
    });
  }
  for (const t of raw.tables) {
    for (const c of t.columns) {
      if (!c.ref || !names.has(c.ref.table)) continue;
      entities.get(t.name)!.belongsTo.push({ entity: c.ref.table, column: c.name });
      entities.get(c.ref.table)!.hasMany.push({ entity: t.name, column: c.name });
    }
  }
  const enums: Record<string, string[]> = {};
  for (const [name, values] of raw.enums) enums[name] = values;
  return { source, entities: [...entities.values()], enums };
}

/** Distinct entities an entity links to, either way. */
export function linkCount(e: DomainEntity): number {
  return new Set([...e.belongsTo, ...e.hasMany].map((l) => l.entity)).size;
}

/** Most-connected first (the core of the domain), then by name. */
export function rankEntities(entities: DomainEntity[]): DomainEntity[] {
  return [...entities].sort((a, b) => linkCount(b) - linkCount(a) || a.name.localeCompare(b.name));
}

/** Finds an entity by table/model name or plain-words label, singular or plural, any case. */
export function findEntity(model: DomainModel, query: string): DomainEntity | undefined {
  const q = query.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "_");
  return (
    model.entities.find((e) => norm(e.name) === q) ??
    model.entities.find((e) => norm(e.label) === q) ??
    model.entities.find((e) => norm(entityLabel(q)) === norm(e.label))
  );
}
