-- Fixture: adds payments, extends the states, and tidies up.
alter type payment_status add value if not exists 'refunded';

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  amount numeric(10, 2) not null,
  status payment_status not null default 'pending'
);

-- drizzle-kit style: wrapped in a DO block.
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

alter table bookings drop constraint bookings_status_check;
alter table bookings add constraint bookings_status_check check (status = any (array['held'::text, 'confirmed'::text, 'cancelled'::text]));
alter table events add column if not exists capacity integer, add column status text default 'draft';
alter table attendees rename column full_name to display_name;
drop table if exists scratch;
