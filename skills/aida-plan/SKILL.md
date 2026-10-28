---
name: aida-plan
description: Pick the readers and top tasks for a new app, lay out the help site, and produce outline cards for review. Use after aida-discover has mapped the app and aida-understand has written the brief, or when re-planning site structure after a big feature change. High-stakes, low-frequency — rare escalation target for aida-repair too.
---

# aida-plan

Model tier: **deep**. This is rare, high-stakes planning: picking the wrong readers or top tasks
shapes everything downstream. Also the escalation target when `aida-repair` fails twice on one
walkthrough (see that skill).

## Input

The merged summary from `aida-discover` (routes, roles, labels, likely tasks per area) and the app
brief (`aida brief show --config <cfg>`, written by `aida-understand`) — not the app's source
code, and not the full discover transcript. After an interview (`aida-interview`), also `aida
interview notes --config <cfg> --goes-to plan`: what to leave out and the tasks that matter
most. Follow them, then `aida interview applied <ids> --config <cfg>`.

## What it produces

1. **Readers.** Who actually uses the app (roles), in plain language — "office staff taking
   entries", not a technical role string. Start from the brief's `readers` and their jobs.
2. **Top tasks.** Per reader, the handful of tasks worth a walkthrough — ranked by how often a
   real user would hit them, not by how interesting they are to write.
3. **Site layout.** How pages group in the help site nav. Each card gets a `section:` — a
   feature group inside How do I… named after the app's own menu item (`Payments`,
   `Competitors`), or a top-level category (`Getting started`, `Troubleshooting and FAQ`). See
   `references/walkthrough-cheatsheet.md` → `section:`.
4. **Outline cards** — the thing the person actually reviews at checkpoint 1:

   ```
   - Add a new competitor and their first entry
     for: office staff · section: Competitors · from Competitors page to a submitted entry
   - Move Alex to the waitlist
     for: office staff · section: Sessions · labels: "Move to waitlist" · needs session-full · leaves alex-on-waitlist
   ```

   Put an on-screen name the card relies on in quotes, or in `labels:`, only when discover
   actually reported that label. Capture checks each one against the real screen. When the
   brief's "Several ways to do one thing" lists the task, add its other starting screens:
   `paths: from the entry, from the competitor, from "Payments"` (one card, not one per path; a
   quoted screen name is checked against capture like a label). The writer turns each into a
   walkthrough `paths:` entry with its own start page and opening steps, joining the shared rest
   (the payment form), and a `when` sentence from the brief: when a reader picks that way. Also
   check the domain model: a thing reachable from two others (a payment against a booking or an
   attendee) usually means two ways in. If the brief says two ways save differently (paying
   against an attendee spreads it across their bookings), note it on the card; capture will
   compare them.
5. **Data each card needs, leaves or clears.** Most tasks change data, so say it on the card in
   kebab-case state names (`needs session-full`, `leaves alex-on-waitlist`, `clears
   alex-in-morning`); the writer turns them into the walkthrough's `needs`/`leaves`/`clears`.
   Show the capture order they imply at the review (when re-planning, run `aida order
   --config <cfg>` and show its output). Starting data no card leaves ("Alex is in the morning
   block") is a config `states` entry with a `setup` hook that puts it in through the app's own
   API and a `check` hook; suggest those to the person rather than a setup-only walkthrough.

Once the person approves, save the cards: write the list to a file and run `aida outline import
<file> --config <cfg>` (or `AIDA outline add "<title>" --label "<name>" ...` per card). Cards
live in `outline.yaml` from then on. Hand the approved list to `aida` (the router), which fans
the cards out to `aida-write`.

**Re-planning:** run `aida outline list --drift --json` first. Each drift entry is a name the
card promised that the screen doesn't have (`expected`, the closest `seen`, `step`). A renamed
label: rename or re-scope the card to match the screen. A button or result that isn't there at
all may be an app bug, not a plan error: ask the person before re-scoping (decision 30), and
never quietly drop the promise. Use `aida outline status <id> dropped` to drop a card rather
than deleting it.

## Rules

- Ground every task and reader in something `aida-discover` actually found — a route, a label,
  a role. Never invent a task the app doesn't appear to support (see
  `references/safety.md` → Truthfulness).
- Use the plain-language vocabulary from `references/style.md` and the brief's "Words it uses"
  in every card and reader name — these are the first thing a person reads.
- Rank tasks by the brief's rhythm and rules: what readers do every week, and the mistakes its
  rules warn about, come before rare admin.
- When the brief has **Workflows**, order each job's cards the way the job runs (its first task in
  `Getting started`, the rest first in their sections) and say in each `purpose` what comes next.
  One card per task, never one walkthrough for a whole job; steps outside the app aren't captured.
  A pitfall in **Where people get stuck** that a task can show belongs on its card as a note.
- A reader whose `devices` lists only `phone` (or puts it first) gets their cards captured at
  phone size: note `phone` on the card so the writer sets `start.viewport`.
- Keep the outline small enough to review in one sitting. If discover turned up more tasks than
  make a sane first site, cut to the top ones and say what you cut and why.

## Token rules

See `references/tokens.md`. You're the one skill allowed a wide read of the discover summaries at
once — that's the point of the deep tier — but still never re-read the app's source directly;
ask `aida-discover` to re-scan an area instead if the summary is insufficient.
