---
app: Acme Events
updated: 2026-10-27
readers:
  - role: organiser
    name: Event organisers
    job: Run ticketed community events from announcement to the last payment.
  - role: door_staff
    name: Door staff
    job: Check people in and take payments on the night.
---

# Acme Events brief

<!-- A prompt that is never passed on. -->

## What it's for

Acme Events lets small community groups sell seats at their events and see who has paid, without a spreadsheet. **Organisers** publish an event, take bookings and record payments.

Before it, bookings lived in a shared spreadsheet and cash was counted twice.

## Who uses it

Event organisers set up events and chase unpaid bookings, a few times a week. Door staff use it on the night to check people in.

## Things it keeps track of

- **Event**: has many Bookings. States: draft, published or cancelled.
- **Booking**: belongs to an Event and an Attendee; has many Payments.
- **Payment**: belongs to a Booking. Status: pending, completed or refunded.

## Words it uses

| Term | Meaning | Not to be confused with |
| --- | --- | --- |
| Booking | One attendee's seats at one event | Ticket (the printed pass) |
| Held | A booking waiting for payment | Cancelled |

## Rules that matter

- A refunded payment can't be changed back, so check the amount before refunding.

## Rhythm

Bookings open weeks ahead; most payments arrive in the last few days; door staff record cash on the night.

## Several ways to do one thing

- Record a payment: from the booking (one booking), from the attendee (all their bookings), or from Payments (money that arrived first).

## Open questions

- Can a door staff member refund a payment? (asked; waiting)
