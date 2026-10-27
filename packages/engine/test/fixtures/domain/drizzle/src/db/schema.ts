// Fixture: a fictional "Acme Events" app's Drizzle schema (read as text by `aida domain`, never run).
import { pgTable, pgEnum, uuid, varchar, text, integer, numeric, timestamp, foreignKey, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const PAYMENT_STATUSES = ["pending", "completed", "refunded"] as const;
export const paymentStatus = pgEnum("payment_status", PAYMENT_STATUSES);
export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled"]);

// Shared bookkeeping columns, spread into each table.
const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
};

export const events = pgTable("events", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 200 }).notNull(),
  startsAt: timestamp("starts_at").notNull(),
  venue: text(),
  capacity: integer(),
  status: eventStatus().default("draft").notNull(),
  ...timestamps,
});

export const attendees = pgTable("attendees", {
  id: uuid().defaultRandom().primaryKey(),
  fullName: text("full_name").notNull(),
  email: text().notNull(), // e.g. sam@example.com
  referredBy: uuid("referred_by").references((): AnyPgColumn => attendees.id),
  ...timestamps,
});

export const bookings = pgTable(
  "bookings",
  {
    id: uuid().defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    attendeeId: uuid("attendee_id").notNull(),
    seats: integer().default(1).notNull(),
    status: text().default("held").notNull(),
    notes: text(),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.attendeeId], foreignColumns: [attendees.id], name: "bookings_attendee_id_fkey" }),
    check("bookings_status_check", sql`status = ANY (ARRAY['held'::text, 'confirmed'::text, 'cancelled'::text])`),
    check("bookings_seats_check", sql`seats > 0`),
  ],
);

export const payments = pgTable("payments", {
  id: uuid().defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull(),
  amount: numeric({ precision: 10, scale: 2 }).notNull(),
  method: text({ enum: ["card", "cash", "bank transfer"] }).notNull(),
  status: paymentStatus().default("pending").notNull(),
  paidAt: timestamp("paid_at"),
  ...timestamps,
});

// A link declared only through relations(), with no foreign key in the table.
export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
}));
