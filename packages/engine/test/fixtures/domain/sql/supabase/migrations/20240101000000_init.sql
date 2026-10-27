-- Fixture: a fictional "Acme Events" app's first migration.
create type public.payment_status as enum ('pending', 'completed');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  starts_at timestamp with time zone not null,
  venue text,
  created_at timestamptz default now()
);

create table if not exists "attendees" (
  "id" uuid primary key default gen_random_uuid(),
  "full_name" text not null,
  "email" text not null, -- sam@example.com
  "user_id" uuid references auth.users (id)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id uuid NOT NULL,
  seats integer NOT NULL DEFAULT 1 CHECK (seats > 0),
  status text NOT NULL DEFAULT 'held',
  CONSTRAINT bookings_attendee_fk FOREIGN KEY (attendee_id) REFERENCES public.attendees (id),
  CONSTRAINT bookings_status_check CHECK (status IN ('held', 'confirmed'))
);

-- A function body with semicolons inside dollar quotes must not split the file.
create or replace function public.touch() returns trigger language plpgsql as $$
begin
  new.created_at = now();
  return new;
end;
$$;

create table scratch (id serial primary key);
