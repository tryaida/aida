// `aida domain` (M31): the domain model read statically from a fictional "Acme Events" app's
// Drizzle schema, Prisma schema and SQL migrations.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDomain } from "../../src/commands/domain.js";
import { buildDomain, findEntity, formatDomain, formatEntity, plainDomainList, type DomainEntity, type DomainModel } from "../../src/domain/index.js";
import { parseSqlMigrations, splitStatements } from "../../src/domain/sql.js";
import { parseDrizzle } from "../../src/domain/drizzle.js";
import { buildModel } from "../../src/domain/model.js";
import { entityLabel, parseCheckEnums, plural, singular } from "../../src/domain/text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures", "domain");

function model(kind: "drizzle" | "prisma" | "sql"): DomainModel {
  const result = buildDomain(path.join(fixtures, kind));
  if (!result.ok) throw new Error(result.error);
  return result.model;
}

function entity(m: DomainModel, name: string): DomainEntity {
  const e = m.entities.find((x) => x.name === name);
  if (!e) throw new Error(`no entity ${name}`);
  return e;
}

const col = (e: DomainEntity, name: string) => e.columns.find((c) => c.name === name);

describe("Drizzle schema", () => {
  const m = model("drizzle");

  it("finds the schema through drizzle.config.ts and reads every table", () => {
    expect(m.source).toEqual({ kind: "drizzle", files: ["src/db/schema.ts"] });
    expect(m.entities.map((e) => e.name).sort()).toEqual(["attendees", "bookings", "events", "payments"]);
  });

  it("uses database column names, spreads shared columns and marks primary keys", () => {
    const events = entity(m, "events");
    expect(events.columns.map((c) => c.name)).toEqual(["id", "name", "starts_at", "venue", "capacity", "status", "created_at", "updated_at"]);
    expect(col(events, "id")).toMatchObject({ type: "uuid", primaryKey: true });
  });

  it("reads references(), foreignKey() and relations() links, both ways", () => {
    const bookings = entity(m, "bookings");
    expect(col(bookings, "event_id")?.ref).toBe("events.id");
    expect(col(bookings, "attendee_id")?.ref).toBe("attendees.id");
    expect(bookings.belongsTo.map((l) => l.entity).sort()).toEqual(["attendees", "events"]);
    expect(entity(m, "events").hasMany).toEqual([{ entity: "bookings", column: "event_id" }]);
    expect(col(entity(m, "payments"), "booking_id")?.ref).toBe("bookings.id");
    // A self-reference: an attendee referred by another.
    expect(entity(m, "attendees").belongsTo).toContainEqual({ entity: "attendees", column: "referred_by" });
  });

  it("reads enums: pgEnum (inline or from a const array), { enum: [...] } and CHECK lists", () => {
    expect(m.enums.payment_status).toEqual(["pending", "completed", "refunded"]);
    expect(col(entity(m, "payments"), "status")).toMatchObject({ type: "payment_status", enum: "payment_status" });
    expect(m.enums["payments.method"]).toEqual(["card", "cash", "bank transfer"]);
    expect(m.enums["bookings.status"]).toEqual(["held", "confirmed", "cancelled"]);
    // A range check isn't a list of states.
    expect(col(entity(m, "bookings"), "seats")?.enum).toBeUndefined();
  });
});

describe("Prisma schema", () => {
  const m = model("prisma");

  it("reads models, enums and @relation foreign keys", () => {
    expect(m.source.kind).toBe("prisma");
    expect(m.entities.map((e) => e.name)).toEqual(["Event", "Attendee", "Booking", "Payment"]);
    expect(m.enums.PaymentStatus).toEqual(["pending", "completed", "refunded"]);
    const payment = entity(m, "Payment");
    expect(col(payment, "status")).toMatchObject({ enum: "PaymentStatus" });
    expect(col(payment, "booking_id")).toBeUndefined();
    expect(col(payment, "bookingId")?.ref).toBe("Booking.id");
    expect(col(payment, "tags")?.type).toBe("string[]");
    // Relation fields add links, not columns.
    expect(col(entity(m, "Event"), "bookings")).toBeUndefined();
    expect(entity(m, "Booking").belongsTo.map((l) => l.entity)).toEqual(["Event", "Attendee"]);
    expect(entity(m, "Event").hasMany).toEqual([{ entity: "Booking", column: "eventId" }]);
  });
});

describe("SQL migrations", () => {
  const m = model("sql");

  it("replays the files in order: created, altered, renamed and dropped tables", () => {
    expect(m.source.files).toEqual(["supabase/migrations/20240101000000_init.sql", "supabase/migrations/20240201000000_payments.sql"]);
    expect(m.entities.map((e) => e.name).sort()).toEqual(["attendees", "bookings", "events", "payments"]);
    const events = entity(m, "events");
    expect(events.columns.map((c) => c.name)).toEqual(["id", "name", "starts_at", "venue", "created_at", "capacity", "status"]);
    expect(col(events, "starts_at")?.type).toBe("timestamp with time zone");
    expect(col(entity(m, "attendees"), "display_name")).toBeDefined();
    expect(col(entity(m, "attendees"), "full_name")).toBeUndefined();
  });

  it("reads inline, table-level and DO-block foreign keys; a table outside public stays a bare ref", () => {
    const bookings = entity(m, "bookings");
    expect(col(bookings, "event_id")?.ref).toBe("events.id");
    expect(col(bookings, "attendee_id")?.ref).toBe("attendees.id");
    expect(col(entity(m, "payments"), "booking_id")?.ref).toBe("bookings.id");
    expect(col(entity(m, "attendees"), "user_id")?.ref).toBe("auth.users.id");
    expect(entity(m, "attendees").belongsTo).toEqual([]);
    expect(entity(m, "bookings").hasMany).toEqual([{ entity: "payments", column: "booking_id" }]);
  });

  it("follows enum types and CHECK lists as they change", () => {
    expect(m.enums.payment_status).toEqual(["pending", "completed", "refunded"]);
    expect(col(entity(m, "payments"), "status")).toMatchObject({ type: "payment_status", enum: "payment_status" });
    // Dropped and re-added with a third state.
    expect(m.enums["bookings.status"]).toEqual(["held", "confirmed", "cancelled"]);
  });

  it("splits statements outside strings, comments and dollar quotes", () => {
    const stmts = splitStatements("create table a (x text default ';'); -- c;\ncreate function f() as $$ begin; end; $$; /* ; */ drop table a");
    expect(stmts).toHaveLength(3);
    expect(stmts[1]).toContain("begin; end;");
  });
});

describe("source preference and errors", () => {
  it("reports no schema rather than throwing", () => {
    const result = buildDomain(path.join(here, "..", "fixtures", "brief", "acme-app"));
    expect(result.ok).toBe(false);
  });

  it("--source picks one kind", () => {
    expect(buildDomain(path.join(fixtures, "drizzle"), { source: "sql" }).ok).toBe(false);
  });
});

describe("plain words", () => {
  it("names entities in the singular and lists in the plural", () => {
    expect(entityLabel("payment_links")).toBe("Payment link");
    expect(entityLabel("categories")).toBe("Category");
    expect(entityLabel("classes")).toBe("Class");
    expect(entityLabel("statuses")).toBe("Status");
    expect(entityLabel("EventBooking")).toBe("Event booking");
    expect(singular("status")).toBe("status");
    expect(plural("Entry")).toBe("Entries");
    expect(plural("Class")).toBe("Classes");
  });

  it("reads CHECK lists in Postgres' own and the IN form", () => {
    expect(parseCheckEnums("(status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])")).toEqual([{ column: "status", values: ["a", "b"] }]);
    expect(parseCheckEnums("\"kind\" IN ('x', 'y')")).toEqual([{ column: "kind", values: ["x", "y"] }]);
    expect(parseCheckEnums("fee >= 0")).toEqual([]);
  });
});

describe("formatting", () => {
  const m = model("drizzle");

  it("summarises one line per entity, most connected first, with states and links", () => {
    const text = formatDomain(m);
    const lines = text.split("\n");
    expect(lines[0]).toBe("domain from drizzle (src/db/schema.ts): 4 entities, 4 enums, 4 links");
    expect(lines[2]).toMatch(/^Booking \(bookings\): seats, status: held\|confirmed\|cancelled, notes — belongs to Event, Attendee; has many Payments$/);
    expect(text).toContain("Payment (payments): amount, method: card|cash|bank transfer, status: pending|completed|refunded, paid_at — belongs to Booking");
    // Bookkeeping and foreign-key columns are left out of the summary.
    expect(text).not.toMatch(/created_at|event_id/);
  });

  it("shows one entity in full", () => {
    const text = formatEntity(m, findEntity(m, "Payment")!);
    expect(text).toContain("booking_id uuid -> bookings.id");
    expect(text).toContain("status payment_status : pending | completed | refunded");
  });

  it("finds an entity by table name, label or plural", () => {
    expect(findEntity(m, "bookings")?.name).toBe("bookings");
    expect(findEntity(m, "Booking")?.name).toBe("bookings");
    expect(findEntity(m, "nope")).toBeUndefined();
  });

  it("writes plain-words bullets for the brief", () => {
    const text = plainDomainList(m);
    expect(text).toContain("- **Booking**: belongs to an Event and an Attendee; has many Payments. Details: seats, notes. Status: held, confirmed or cancelled.");
  });
});

describe("runDomain", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("prints the summary by default and the model with --json", async () => {
    expect(await runDomain({ repo: path.join(fixtures, "prisma"), json: false })).toBe(0);
    expect(logSpy.mock.calls[0][0]).toContain("domain from prisma");
    expect(await runDomain({ repo: path.join(fixtures, "prisma"), json: true })).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[1][0] as string);
    expect(parsed.source.kind).toBe("prisma");
    expect(parsed.entities).toHaveLength(4);
    expect(parsed.enums.PaymentStatus).toHaveLength(3);
  });

  it("zooms to one entity with --entity", async () => {
    expect(await runDomain({ repo: path.join(fixtures, "sql"), entity: "payment", json: true })).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.entity.name).toBe("payments");
    expect(parsed.enums.payment_status).toEqual(["pending", "completed", "refunded"]);
  });

  it("fails clearly on a missing repo, no schema, an unknown entity or source", async () => {
    expect(await runDomain({ repo: path.join(here, "nope"), json: false })).toBe(1);
    expect(await runDomain({ repo: path.join(here, "..", "fixtures", "brief", "acme-app"), json: true })).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).ok).toBe(false);
    expect(await runDomain({ repo: path.join(fixtures, "sql"), entity: "tickets", json: false })).toBe(1);
    expect(await runDomain({ repo: path.join(fixtures, "sql"), source: "mongo", json: false })).toBe(1);
  });
});

describe("review fixes: SQL replay edge cases", () => {
  const replay = (...sql: string[]) => parseSqlMigrations(sql.map((text, i) => ({ path: `${i}.sql`, text })));
  const table = (raw: ReturnType<typeof replay>, name: string) => raw.tables.find((t) => t.name === name)!;

  it("names an unnamed CHECK the Postgres way, so a later DROP CONSTRAINT clears it", () => {
    const raw = replay(
      "create table bookings (id uuid primary key, status text check (status in ('held', 'confirmed')), kind text, check (kind in ('a', 'b')))",
      "alter table bookings drop constraint bookings_status_check, drop constraint bookings_kind_check",
    );
    expect(table(raw, "bookings").columns.find((c) => c.name === "status")?.enum).toBeUndefined();
    expect(table(raw, "bookings").columns.find((c) => c.name === "kind")?.enum).toBeUndefined();
    expect(raw.enums.has("bookings.status")).toBe(false);
  });

  it("rekeys enums and incoming refs on RENAME COLUMN and RENAME TO; DROP COLUMN clears them", () => {
    const raw = replay(
      "create table events (id uuid primary key, code text unique, status text check (status in ('draft', 'live')))",
      "create table bookings (id uuid primary key, event_code text references events(code), note text)",
      "alter table events rename column status to state",
      "alter table events rename column code to slug",
      "alter table events rename to happenings",
      "alter table happenings drop constraint events_status_check",
    );
    const happenings = table(raw, "happenings");
    expect(happenings.columns.find((c) => c.name === "state")?.enum).toBeUndefined();
    expect([...raw.enums.keys()].filter((k) => k.includes("."))).toEqual([]);
    expect(table(raw, "bookings").columns.find((c) => c.name === "event_code")?.ref).toEqual({ table: "happenings", column: "slug" });

    const kept = replay(
      "create table events (id uuid primary key, status text check (status in ('draft', 'live')))",
      "alter table events rename column status to state",
      "alter table events rename to happenings",
    );
    expect(table(kept, "happenings").columns.find((c) => c.name === "state")?.enum).toBe("happenings.state");
    expect(kept.enums.get("happenings.state")).toEqual(["draft", "live"]);

    const dropped = replay(
      "create table events (id uuid primary key, code text, status text check (status in ('draft', 'live')))",
      "create table bookings (id uuid primary key, event_code text references events(code))",
      "alter table events drop column status, drop column code cascade",
    );
    expect(dropped.enums.has("events.status")).toBe(false);
    expect(table(dropped, "bookings").columns[1].ref).toBeUndefined();
  });

  it("reads ADD CHECKLIST as a column, not a CHECK constraint", () => {
    const raw = replay("create table events (id uuid primary key)", "alter table events add checklist text, add constrainty int");
    expect(table(raw, "events").columns.map((c) => c.name)).toEqual(["id", "checklist", "constrainty"]);
  });

  it("leaves a known table alone on CREATE TABLE IF NOT EXISTS", () => {
    const raw = replay("create table events (id uuid primary key, name text)", "alter table events add column venue text", "create table if not exists events (id uuid primary key)");
    expect(table(raw, "events").columns.map((c) => c.name)).toEqual(["id", "name", "venue"]);
  });
});

describe("review fixes: Drizzle CHECK through a column reference", () => {
  it("reads sql`${table.status} IN (...)` as the status column's values", () => {
    const raw = parseDrizzle([
      {
        path: "schema.ts",
        text: 'export const bookings = pgTable("bookings", { id: uuid().primaryKey(), bookingStatus: text("booking_status") }, (table) => [check("s", sql`${table.bookingStatus} IN (\'held\', \'confirmed\')`)]);',
      },
    ]);
    expect(raw.tables[0].columns.find((c) => c.name === "booking_status")?.enum).toBe("bookings.booking_status");
    expect(raw.enums.get("bookings.booking_status")).toEqual(["held", "confirmed"]);
  });
});

describe("review fixes: the brief's pre-fill", () => {
  it("never lists standalone tables", () => {
    const raw = parseSqlMigrations([{ path: "0.sql", text: "create table events (id uuid primary key); create table bookings (id uuid primary key, event_id uuid references events(id)); create table api_tokens (id uuid primary key, secret text)" }]);
    const m = buildModel(raw, { kind: "sql", files: ["0.sql"] });
    const text = plainDomainList(m);
    expect(text).not.toContain("Also stored");
    expect(text).not.toContain("Api token");
  });
});
