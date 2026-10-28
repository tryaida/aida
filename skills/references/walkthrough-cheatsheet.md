# Walkthrough YAML cheat sheet

Derived from `packages/engine/schema/walkthrough.schema.json`. Validate every walkthrough you
write or edit with `npx tsx packages/engine/src/cli.ts validate <file>` (or `aida validate` once
installed) before handing it off — don't hand-check against this sheet alone.

## Top level

```yaml
walkthrough: add-competitor      # slug, matches filename
version: 1
title: Add a new competitor      # user-facing
summary: One or two sentences.
product: Acme Events
for: Office staff taking entries
section: Competitors             # optional: where the page sits in the help site (see below)
verifiedAgainst: { app: "...", routes: [...], sources: [...] }  # filled in after capture, not before
start:
  signed_in_as: office_staff     # or persona.role; both may be set only if they match
  page: /dashboard
  baseUrl: http://127.0.0.1:3100
  persona: { role, name, email, cognitoSub }
data: { <any demo values the steps reference via {{dotted.path}}> }
voice: { provider, model, voiceId, speed, gapSeconds }
intro: { eyebrow, title, subtitle, say, caption }
outro: { title, recap: [...], say, caption }
steps: [ ... ]        # minItems: 1
validate: { database: [ { name, sql, params, expect } ] }   # optional, engineer-owned
needs: [session-full]          # optional: data states that must hold before step 1
leaves: [alex-on-waitlist]     # optional: states true once this walkthrough succeeds
clears: [alex-in-morning]      # optional: states no longer true after it
setup: { as: admin, steps: [ ... ] }   # optional: unrecorded steps run before capture
paths: [ ... ]                 # optional: other ways to start this task (see below)
```

### Data this walkthrough needs and changes

Most tasks change data, so walkthroughs depend on each other. Say so in the file instead of
planning a capture order by hand; `aida order [ids...] --with-deps` prints the order the engine
will use, and `capture`/`build` (`--with-deps`) and `ci` follow it.

- **State names** are kebab-case and describe the data: `session-full`, `alex-on-waitlist`.
- **`needs`**: met by a walkthrough that `leaves` the state (it runs first), or by a `setup`/`check`
  hook for the state in `aida.config` `states` (then any order works, and the walkthrough can be
  captured on its own or twice). A walkthrough that `clears` a state runs after those that need it.
- **`setup:`** steps use the same `do:`/`check:`/`actions:` grammar as `steps`, but have no
  `say`/`caption`/`page_text`/camera fields and are never filmed. `as:` signs in as another role.
  Use them for data only this walkthrough needs (a second competitor to pick from).
- **State hooks** get `ctx.request`, an API client. Without `as:` on the state it shares the
  walkthrough's own signed-in session and cookies, so a hook that signs in through the API would
  sign the recording out or switch who it shows: give that state `as:` a role other than the
  walkthrough's own, so the hook gets a session of its own.
- **`{{run.id}}`** is a short id unique to each capture run, the same for every walkthrough in it.
  It's for records setup creates that mustn't collide with an earlier run's (`ctx.runId` in a
  hook). `run` is reserved: `data` can't define it. Never let it reach typed text, `say`,
  `caption` or `page_text` (validate warns): screenshots would change every run.
- **Capturing a walkthrough that saves data twice** ("Add a session" types "Morning session"):
  keep the typed name fixed. Give it a `needs` state whose setup hook deletes the earlier
  "Morning session" if it's there, or rely on the database reset before it.

### Several ways to do one task: `paths:`

One walkthrough per task. When the task can start from more than one screen (a payment from the
booking, from the attendee, or from Payments), the main `steps` are one way and `paths` lists the
others. Each path has its own start page and opening steps, then joins the main steps at the step
named by `joins:` and shares the rest. When a way uses its own form to the end (a dialog on a list
row that records the payment itself), leave `joins:` out: the path runs its own steps to its own
end, and its last step must end in a check (`check:`, or an `expect`/`waitFor`/`waitForUrl`).
Never invent a shared step just to have something to join.

```yaml
paths:
  - id: from-attendee                    # kebab-case, unique in the walkthrough
    title: From the attendee's page       # reader-facing
    when: Use this when the attendee is paying for several bookings at once.   # one plain sentence
    start: { page: /attendees/7 }         # signed_in_as only if it repeats the walkthrough's; no persona
    steps:                                # same step schema as `steps`; ids differ from main step ids
      - id: open-attendee-payment
        title: Open the payment form
        do: click "Pay" button
        page_text: On the attendee's page, select **Pay**.
    joins: fill-amount                    # a main step id
    note: Paying here spreads the amount across the attendee's bookings.   # only when capture flags it
  - id: from-entries-list                 # runs to its own end: no joins
    title: From the Entries list
    when: Use this when they're paying for one entry and you're on Entries.
    start: { page: /entries }
    steps:
      - id: list-record-payment
        title: Record Payment on the row
        do: click "Record Payment" button
      - id: list-save
        title: Record it
        do: click "Record" button
        check: text "Paid" is visible        # required: the last step proves the task is done
```

- A path can't have `needs`/`leaves`/`clears`/`setup`/`validate`: it shares the walkthrough's data.
  Capture runs reset → each path → reset → main, so every run starts from the same data, each path
  with its own `{{run.id}}`, and the main run goes last (walkthroughs that need its data see the
  main run's). Paths need that reset: with no database adapter `reset()`, `--no-reset`, or a
  walkthrough inside a dependency chain (where a reset would erase an earlier walkthrough's data),
  each path is marked not captured with the reason, and the page won't publish until it is.
- Each path gets a short narrated clip, `<id>.path-<pathId>.mp4` (+ captions) next to the main
  video: a title card (`title`, `when`), its opening steps narrated from their own `say`, then
  "Then continue from step N: <title>" ("Done" for a path without `joins`). The page embeds it
  under the path; PDFs keep the crops.
- To see the screen after a path step: `aida inspect --walkthrough <id> --after <pathId>/<stepId>`.
- A path's steps are screenshotted on their own: give them their own `mask:` and `blur:` for any
  personal data they show (the main steps' blur doesn't cover them). Blur and callout edits take
  `<pathId>/<stepId>`: `aida edit addBlur <file> from-attendee/open-attendee-payment '<json>'`.
- Capture compares what each path saved with the main path. Reads don't count as saves (GET, a
  Next.js server action that revalidated nothing and didn't redirect, a query to a GraphQL
  endpoint), but a server action only one of the two runs called is still flagged: it may save
  without revalidating. After every run it also runs the walkthrough's end checks (the final
  step's checks and `validate.database`), so give the walkthrough a `validate.database` check of
  what the task should leave (the entry is paid) — that's what catches a way that saves but
  leaves different data. A failing step (the final check included) fails the path; a failing
  database check only flags it. A difference prints e.g.
  `path from-attendee saves POST /api/payments/allocate once; main path saves POST /api/payments
  once` or `path from-list leaves different data: end checks fail where the main path's pass
  (entry-paid)` and is recorded as `pathDiffs` in `validation.json` (every path's end checks as
  `pathChecks`); it doesn't fail the capture. Find out what the difference means, then write
  `note:`. The page shows the note only for a flagged path.
- `aida paths <id> --config <cfg> --json` lists other screens whose code makes the same save as the
  captured main path, not yet covered by `paths`. Candidates only: ask before adding one.
- Edit with `aida edit addPath <file> '<json>'`, `removePath`, `setPathField <file> <pathId>
  <title|when|note|joins|page> <value>` (an empty `joins` makes the path run to its own end),
  `setPathStepField` and `setPathStepActions`. Lock keys:
  `path:<walkthroughId>:<pathId>` (whole path), `...:<field>`, `...:step:<stepId>`.
- Pages show the main path in full, then "Other ways to do this": each path's title, `when`, its
  opening steps with screenshots and "Then continue from step N" (a path without `joins` shows all
  its steps and no continue line; its clip ends on "Done"). The video follows the main path.

### Who it signs in as

`start.signed_in_as` is shorthand for `start.persona.role`. Set either, or both when they name the
same role; different roles is a validate error. Pages say who to sign in as from config `roles`
(`roles: { admin: "an organiser", office_staff: { name: "office staff" } }`); capture still signs in
with the role id. With no entry, the reader-facing name falls back to `for:`, then `readers`, then
the id with `_`/`-` as spaces.

### `section:` — where the page sits

Optional. Leave it out and the page goes straight into **How do I…**. A value whose first part
names a top-level category — `Getting started`, `How do I…`, `Screens and settings`, `Words we
use`, `Troubleshooting and FAQ`, `What's new` (title or slug, any case) — goes into that category;
anything else is a feature group inside How do I…. Nest with ` / `:

```yaml
section: Payments                      # How do I… / Payments
section: Entries / Late entries        # How do I… / Entries / Late entries
section: Getting started               # Getting started
```

Plain words only (letters, numbers, spaces, light punctuation). Use the app's own name for the
area (the menu item a reader clicks), and reuse the same value across walkthroughs in that area.

## A step

```yaml
- id: open-competitors
  chapter: Add the competitor      # groups steps into video chapters / page sections
  title: Open Competitors
  say: Then open Competitors from the menu.
  caption: Then open Competitors from the menu.
  page_text: Click **Competitors** in the left-hand menu.
  camera: full   # or { focus: <target>, zoom: 1.25, align: top|left|right }
  hold: 1.5       # optional seconds to hold the frame
  mask: ["{{competitor.email}}"]   # optional values to blur in screenshots/video
  actions: [ ... ]
```

## Actions (each has `do` + a target, except `waitForUrl`/`goto`; `press`'s target is optional)

| `do` | Needs | Notes |
| --- | --- | --- |
| `click` | `target`, optional `highlight` | |
| `type` | `target`, `text` | `text` may use `{{data.path}}` |
| `select` | `target`, `option` | native `<select>` — runs as Playwright's `selectOption`, not a click |
| `point` | `target`, optional `highlight` | no interaction, just calls out something |
| `expect` | `target`, optional `text`, `exact`, `highlight` | assertion; capture fails if not visible. `text`: the target's text must contain it (Playwright `toContainText`); with `exact: true` equal it, whitespace collapsed (`toHaveText`); reads the element's `textContent`, so CSS upper-casing doesn't count. `"/pattern/"` (or `"/pattern/i"`, ignore case) is a regular expression, checked at validate; escape a literal `/` as `\/` |
| `press` | `key`, optional `target`, `highlight` | Playwright key names: `Enter`, `Escape`, `Tab`, `ArrowDown`, `F2`, one character, chords like `Control+K`, `ControlOrMeta+K` (any case; `ctrl`/`cmd`/`esc` accepted and stored as Playwright's names; unknown names fail validate). The target must take focus (a field, button or link). With `target` the key goes to that element (focused first), else to whatever has focus. Waits right after it run as part of it, like a click |
| `hover` | `target`, optional `highlight` | moves the pointer over it without clicking (menus, tooltips that open on hover) |
| `focus` | `target`, optional `highlight` | keyboard focus without a click; fails if the element can't take focus |
| `waitFor` | `target`, optional `snapshot`, `highlight` | pauses until visible |
| `waitForUrl` | `pattern` | regex string |
| `scrollTo` | `target` | |
| `goto` | `path` | direct navigation |

## Plain-words `do:`/`check:` (a step may use these instead of, or alongside, `actions:`)

```yaml
do: click "Add competitor" button
do: fill "First name" with "{{competitor.firstName}}"
do: select "Class" option "Open"          # native <select> only — see `select` above
check: text "Competitor added" is visible
check: text exactly "Saved" is visible     # whole text is "Saved" (same as do: expect text exactly "Saved")
do: press "Enter"                          # to whatever has focus; key names any case: "enter", "ctrl+k"
do: press "Enter" in "Search"              # in the field labelled Search
do: hover "Settings" button
do: focus "Email"                          # the field labelled Email (or: focus "Email" textbox)
do: go to /competitors
do: wait for url /competitors/*
```

Unrecognised phrasing is rejected at validate/edit time — write an explicit `actions:` entry
instead. `aida edit setStepField <file> <id> do '...'` / `... check '...'` repairs one of these
in place; `aida edit setStepActions <file> <id> '[...]'` replaces the whole `actions:` list for
anything plain words can't say.

## Targets (locator, matches Playwright role/label/text locators — never raw CSS unless needed)

```yaml
target: { role: button, name: "Create Competitor", exact: true }
target: { label: "First Name" }
target: { placeholder: "Search competitors..." }
target: { text: "Competitors for Riverbend Show 2026" }
target: { css: "aside" }           # last resort — on-screen label locators survive redesigns
target: { role: row, hasText: "...", within: { css: "main" } }
target: { role: button, name: "Delete", within: { role: group, name: "Riverbend entry" } }
target: { role: button, name: "Delete", nth: 1 }
```

`exact: true` on a target makes its name, label or text match whole (`{ text: "Saved", exact: true }`
won't match "Saved 2 drafts"). To check what a found element *says*, use the expect's own
`text`/`exact` instead: `{ do: expect, target: { role: status }, text: "1 order found", exact: true }`.

`role` + `text` isn't a second way to name the element — `text` filters the role/name match down
to elements whose text contains it (same as the explicit `hasText` field), useful when a role+name
still returns several elements (e.g. a `row` with a cell's contents as `text`).

**Two interactive elements with the same role+name** (e.g. a "Delete" button in every row):
`aida inspect` prints a disambiguator after each one — `(within: "Riverbend entry")` when there's
a nearest named group/fieldset/region/dialog to scope by, else `(nth: N)`. Prefer `within` (a
target scoped to `{ role: group, name: "..." }` or whatever the printed name's role is — survives
reordering); fall back to `nth` (0-based, applied last, after every other narrowing) only when
there's no containing landmark to scope by.

**Label matching is tolerant by default**, tried in this order:

1. Exact match against the element's full accessible name.
2. The label's own short name — the text of the `<label>` itself with any nested hint element
   (e.g. a `<span>Optional</span>`) stripped out, so `<label>Address <span>Optional</span></label>`
   matches a target of `"Address"` even though the accessible name is "Address Optional". This is
   the same short name `aida inspect` prints in parens (`label: "Address Optional"`) — use the
   quoted short name in the target, not the full accessible name.
3. A marker-stripped starts-with match: trailing `*`/`(required)`/`(optional)` hint text ignored,
   for a label that doesn't wrap its hint in its own element (so a form adding "(optional)" to a
   label doesn't break an existing walkthrough).

Set `exact: true` on the target to force a strict match (step 1 only) when two labels only differ
by hint text.

`highlight` can be `true` or its own target (e.g. highlight a containing row while clicking a link
inside it). `padUnion` on a target grows the highlight box to include another target.

## Interpolation

`{{competitor.firstName}}` etc. pull from the walkthrough's own `data` block. Never hardcode a
value that should come from `data` — it makes repair and demo-data swaps harder. Reader-facing
text (`title`, `say`, `caption`, `page_text`, callout labels, `intro`/`outro`, a path's `title`/
`when`/`note`) is printed and spoken with `{{data}}` filled in; `aida validate` fails a placeholder
there with no value. `{{run.*}}` is never printed (it is dropped from that text).

## Forbidden in user-facing fields (`title`, `say`, `caption`, `page_text`, `intro`, `outro`)

See `references/style.md`. No "IR", "journey", or exposing the internal step-file format name.
