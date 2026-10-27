// `aida domain` (build-plan.md M31, decision 33): the app's domain model read statically from its
// database schema — the things it keeps track of, how they relate, and the states they move
// through — so the Understand step can write the brief without reading the whole repo.

export type DomainSourceKind = "drizzle" | "prisma" | "sql";

export interface DomainSource {
  kind: DomainSourceKind;
  /** Files read, relative to the repo. */
  files: string[];
}

export interface DomainColumn {
  name: string;
  /** As the schema writes it, lowercased: "uuid", "varchar", "timestamp with time zone", or the
   * enum's name for an enum column. */
  type: string;
  /** The entity and column this one points at: `"events.id"`. A table outside the model (e.g.
   * Supabase's `auth.users`) keeps its schema prefix. */
  ref?: string;
  /** Key into `DomainModel.enums` when the column holds one of a fixed set of values (a database
   * enum, or a CHECK constraint listing them). */
  enum?: string;
  primaryKey?: true;
  /** The value a new row gets when none is given, as a reader would say it: `pending`, `0`,
   * `now()`. Most useful on a status column: the state every record starts in. */
  default?: string;
}

/** One link between entities, seen from either end. `column` is the foreign-key column on the
 * child (the entity that belongs to the other). */
export interface DomainLink {
  entity: string;
  column: string;
}

export interface DomainEntity {
  /** Table name (SQL, Drizzle) or model name (Prisma). */
  name: string;
  /** Plain-words singular: "payment_links" -> "Payment link". */
  label: string;
  columns: DomainColumn[];
  belongsTo: DomainLink[];
  hasMany: DomainLink[];
}

export interface DomainModel {
  source: DomainSource;
  entities: DomainEntity[];
  /** Enum name -> its values, in order. Values from a CHECK constraint are keyed `table.column`. */
  enums: Record<string, string[]>;
}

/** What a schema reader hands the model builder: tables with their columns, refs not yet
 * resolved into links. */
export interface RawTable {
  name: string;
  columns: RawColumn[];
}

export interface RawColumn {
  name: string;
  type: string;
  ref?: { table: string; column: string };
  enum?: string;
  primaryKey?: boolean;
  default?: string;
}

export interface RawSchema {
  tables: RawTable[];
  enums: Map<string, string[]>;
}
