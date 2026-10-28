---
name: AIDA
description: Entry point for "make help docs for my app", "update the help site", or anything about AIDA's help site, help chat, walkthroughs, or Studio. Orchestrates discover/understand/plan/write/repair/review as subagents and drives the AIDA engine CLI. Use this first for any AIDA request; it hands off to the other aida-* skills.
---

# AIDA — entry point

Model tier: standard. You orchestrate; you don't do the discovery, planning, writing, or review
work yourself — hand each to its skill, run as a subagent, and hold only its summary. Read
`references/tokens.md` once per session, not per step.

## What this is

AIDA turns a running web app into a self-updating help site: doc pages, narrated videos, help
chat, and an agent connector (MCP server) — all generated from walkthrough YAML files that are
replayed against the real app. See `AGENTS.md` and `docs/scope.md` in the target repo for the
full plan; you don't need to re-read them every run, just this skill and the one you hand off to.

## The first run

Follow `docs/scope.md` → "First run: vibe coder in a coding agent". Ask at most **three plain
questions** across the run, plus the brief's open questions (at most five) or the interview.

**On a new machine or a new app, run `aida doctor --config <cfg>` first** (Node, ffmpeg, Chromium,
disk, the app's address and database, senders, caches, the help app; each with its fix). Fix what
fails before any capture, and rerun it after any capture failure in the `environment` category.
Capture against a production build of a Next.js app (`next build && next start`), not the dev
server, whose cache grows to gigabytes over a run.

1. **Read the repo.** Hand off to `aida-discover` (fan-out, one subagent per app area). It
   returns readers, routes, and likely tasks. Ask your first question here if needed: "start the
   app locally with demo data, or use a test login on the live site?"
2. **Understand.** Hand off to `aida-understand`. It writes `app-brief.md` beside the config
   (purpose, readers and jobs, domain model, words, rules, rhythm, tasks with several starting
   screens) and returns its open questions. Offer a choice: **answer just these** (a minute or
   two), or **an in-depth interview** (10–45 minutes: readers, devices, whole jobs, where people
   get stuck) for help written for their real users. For the interview, load `aida-interview`
   and run it here, not as a subagent; it asks the open questions too. Otherwise ask them now;
   move each answer into its section, delete the question, and rerun `aida brief check`. "Open
   questions" is never published, and `aida build` publishes no failing brief.
3. **Plan.** Hand off to `aida-plan` with the discover summary and the brief. It returns outline
   cards (walkthrough titles + one-line purpose) for the reviewer to approve, rename, or remove —
   **review checkpoint 1: Outline**, shown with the brief and the brand proof sheet (`aida proof
   --config <cfg>`, or the Studio's **Proof sheet**) so the look is approved once. Approved cards
   go to `outline.yaml`.
4. **Write.** For each approved card, hand off to `aida-write` (one subagent per walkthrough) to
   write and validate its YAML — run these subagents **in parallel**. Capture is a different
   story: the engine replays each walkthrough against the one real app/db, so captures must run
   one at a time, never from parallel subagents (see `aida-write`'s own note). Batch them with
   one `aida capture <id1> <id2> --with-deps` call once every card is written. You don't pick
   the order: the engine derives it from each walkthrough's `needs`/`leaves`/`clears`, pulls in
   the walkthroughs that leave data the others need, and never resets the database inside a
   chain; `aida order <ids> --with-deps` prints it. `walkthrough` failures go to
   `aida-repair`; possible app bugs go to the person, and a blocked walkthrough waits on its
   provider (below). Present results as the **step sheet** (screenshots + narration text, no
   video) — **checkpoint 2**. Also run `aida outline list --drift` and show any card whose
   promised names differ from the screen (a passing capture records these on its own; writers
   note the rest). The person decides whether to rename the card or change the walkthrough.
   When a writer can't work a flow out from the screen, offer the person the "Show me"
   recorder: `aida record <id> --config <cfg> --page <path>` — they click through once in a
   browser window and `aida-write` polishes the draft it saves.
5. **Build.** Run `aida build` for everything that passed — it captures (or reuses the capture
   from step 4 with `--skip-capture`), narrates, renders, builds pages + the search index, and
   runs QA in one call. Open the Studio (`npm run dev` in `help/`, then `/studio`) so the person
   can see video and pages — **checkpoint 3: Build**.
6. **Changes in plain words.** Route any follow-up request ("make this slower", "say Shop Kit not
   Shopkit") to the matching skill — most go through `aida-write` or `aida-repair` on just the
   one affected walkthrough, never a full rebuild.
7. **Publish.** Only on the person's explicit OK — **checkpoint 4: Publish**, and only ever a
   person, never auto-run on a first publish (see `references/safety.md`). Run
   `aida publish --to <host>` (or hand off to the engineer path if no host is picked yet), then
   explain in one sentence what happens on future app changes.

## Database safety

Capture runs steps for real, so it refuses unless every database setting the app may start with
is on this machine, refuses a live Stripe key, and warns about real email/SMS senders (rules in
`references/safety.md`). On a refusal, show the message and suggest a Neon or Supabase branch
made for capture, or a local Postgres, with the app started on it. The config opt-ins (`app.database.throwaway`, `app.database.ignoreEnv`, `app.allowLivePayments`,
`app.outbound`) each cover one exact setting; never suggest one without saying what it means
(e.g. "this tells AIDA that database is a disposable copy it may write test records to"), and
never set one yourself without the person's OK.

## Failures that aren't the walkthrough's

- **Possible app bug** (`category: "app"`, or `aida ci`'s "Possible app bugs" section): a save
  that returned success but the screen didn't change, a 5xx, a blank page. Report it to the
  person with the evidence. Never work around it in the walkthrough (decision 30).
- **Blocked** (`capture:blocked` in `report.json`, or "skipped: needs <state>, which <provider>
  didn't leave"): the walkthrough never ran. Repair the provider it names, not this one. "No
  walkthrough leaves <state>" or a cycle is a planning gap: add the providing walkthrough or a
  config `states` setup hook (`aida-plan`).

## Re-capturing a walkthrough that saves data

A retry must not collide with what the last run saved or change what's on screen. Two ways:

1. A `needs` state whose config setup hook is idempotent and puts the data back to the starting
   point (e.g. deletes the earlier "Morning session" before the walkthrough adds it again).
2. The database adapter's reset: `capture`/`build` reset before a chain whose walkthroughs have
   `validate.database` checks, `aida ci` before every chain.

Explain a duplicate/unique-constraint failure as this, not a locator bug, before touching any
target. Run-unique values (`{{run.id}}`) belong in setup data only, never in typed text.

## Orchestration rules

- Each hand-off is a subagent call, not an inline tool loop in this skill. Give the subagent only
  what its own skill says it needs (its walkthrough, its app area, its capture report) — never the
  whole conversation.
- Hold summaries only: after each hand-off, keep the short result (cards, pass/fail list, a
  one-line QA verdict), not the subagent's full transcript.
- Route by model tier: discover → fast, understand and plan → deep, write/repair/demo-data → standard,
  review → standard-in-a-fresh-context. See `skills/agents/*.md` for the Claude Code subagent
  definitions with `model:` set, and `skills/agents/codex-note.md` if the host agent can't switch
  models.
- Never skip checkpoints 1 and 4. Checkpoints 2–3 can be skipped only for a CI-triggered
  cosmetic update (see `references/safety.md`).

## Install

`aida skills install --target <repo>` copies skills into `.claude/skills/` and `.claude/agents/`.

## Engine commands this run assumes

`doctor`, `validate`, `inspect`, `order`, `capture`, `paths`, `render`, `pages`, `qa`, `init`,
`digest`, `domain`, `brief`, `interview`, `outline`, `proof` and `build` all exist — run `aida <command> --help`
for exact flags. Report tokens as you go with `aida usage add` after each subagent turn, and print the run's total with `aida
usage report` (see `references/tokens.md`).
