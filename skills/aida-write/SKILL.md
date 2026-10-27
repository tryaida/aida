---
name: aida-write
description: Write one walkthrough's YAML from an approved outline card, in plain words using on-screen names, then validate and capture it. Runs as one subagent per walkthrough, in parallel with others. Use after aida-plan's outline is approved, when a person asks to change one specific walkthrough's steps or wording, or when AIDA ci flags a new route no walkthrough covers (tier "new") with its exact draft command.
---

# aida-write

Model tier: **standard**. Routine once the outline card and the app brief exist. Run **one
subagent per walkthrough, in parallel** — each sees only its own card, the brief's words and
rules, the style guide, and (on a retry) its own capture report. Parallel subagents may only write
and validate YAML concurrently: capture must never run from two at once (see step 6).

## How

0. Run `aida catch-up --since last` before anything else — it lists edits a person made in the
   Studio since this skill last looked, so a rewrite never clobbers a change made since. Then
   load `aida brief show --config <cfg> --section "Words it uses" --section "Rules that matter"`
   (and "Several ways to do one thing" when the card has `paths:`), not the whole brief.
1. Start from the approved outline card (title, reader, one-line purpose) and the relevant slice
   of the discover summary (routes/labels for that task only) — or, from `aida ci`'s "new" tier
   comment, from the route path and file it named (no card). Either way, label the PR `docs:new`
   when you're done (decisions #24); the reviewer is the app PR's author.
   Set `section:` from the card (or, for a "new" tier page, from the app's menu item for that
   route, matching the `section:` other walkthroughs in that area already use).
2. **Before writing any step**, run `aida inspect <path> --config <cfg> --json` on the
   walkthrough's start page, and again on every page a step navigates to — never guess a role,
   name, or option label from memory or from reading the app's source. It opens that one page
   signed in and prints every interactive element's exact role, accessible name, required/
   disabled state and (for a native `<select>`) its exact option labels, capped around 80 lines
   (`references/tokens.md` has the cost). Use its output verbatim in every target: the role it
   reports (`button` vs `link` — a wrong guess here is the single most common first-capture
   failure), the exact name, and the exact option label for a `select:` action. A field's printed
   line is its **short name** — e.g. `textbox "Address" (label: "Address Optional", optional)` —
   use the quoted short name (`"Address"`) in the target, not the full label text in parens; if a
   field is marked `[required]`, the walkthrough must fill it, don't skip it hoping the app allows
   it empty. Opening a menu or dialog first: `aida inspect <path> --config <cfg> --click "Open
   menu" --json` (button/menuitem/tab/combobox, or any trigger with `aria-haspopup="listbox"` —
   never a save/submit-shaped name; every non-GET request is blocked for the whole scan, so this
   can never submit anything). Repeat `--click` to click several in order (a menu, then its
   item). A custom combobox opens the same way and lists its options (capped at 15). A field that
   only appears after checking a radio/checkbox, or after picking
   an option in a native `<select>` or custom combobox (conditional fields): `aida inspect <path>
   --config <cfg> --check "Other" --json` or `--select "<field>" "<option>"` reveals it before
   scanning. `--area <cssOrLandmark>` scopes a long page down (e.g. `--area dialog`, `--area
   main`). **The page after a save**: write the steps up to the save, validate, then `AIDA
   inspect --config <cfg> --walkthrough <id> --after <saveStepId> --json`. It signs in as the
   walkthrough's persona, runs its setup and its real steps through that one (it really writes,
   with the same safety checks as capture; nothing is recorded) and scans what's on screen then
   (a path's step: `--after <pathId>/<stepId>`). Write the next steps from that output; don't
   guess them. A step failing on the way prints the failure report instead (step 7).
   **When a flow can't be worked out this way** (a drag, a canvas, a multi-part widget, or a
   path through the app nobody has described), ask the person to show it once: `aida record <id>
   --config <cfg> --page <start path> [--as <role>] [--needs <state>...]` opens a browser window
   signed in and set up as capture would be; they click through and press Finish. It writes a
   draft `<id>.yaml` with real targets and replays it once. Then treat the draft as step 3's
   existing walkthrough: keep its targets, rewrite `title`/`say`/`caption`/`page_text` per the
   style guide through `aida edit` (a `say` the person wrote as a Note is their meaning, keep
   it), fill in `summary`/`for:`/`section:`, and resolve every `# TODO`. Never run it headless.
3. **New walkthrough**: write the YAML file from scratch per
   `references/walkthrough-cheatsheet.md`: `start`, `data` (demo values only — see below), `steps`
   with `do`/`say`/`caption`/`page_text`/`actions`. Use on-screen labels for every target
   (`role`+`name`, `label`, `placeholder`, `text`) — never raw CSS unless nothing else identifies
   the element, and use the exact role/name/option-label `aida inspect` reported, not a guess.
   **Changing an existing walkthrough** (e.g. "say Shop Kit not Shopkit"): change the
   field through `aida edit`, never a raw file edit — it's lock-aware (skips a step a person has
   locked) and keeps edit history:
   ```
   aida edit setStepField <file> <stepId> say "Then open Shop Kit from the menu." --by agent --json
   aida edit setStepField <file> <stepId> do 'click "Add competitor" button' --by agent --json
   aida edit setStepActions <file> <stepId> '[{"do":"click","target":{"role":"button","name":"Add competitor"}}]' --by agent --json
   ```
   (or `reorderSteps`/`removeStep`/`setPageBlock`, see `aida edit --help`). `setStepField`
   covers `say`/`caption`/`page_text`/`title`/`hold` and the plain-words `do`/`check` fields;
   `setStepActions` replaces a step's whole `actions:` list; `aida edit setData <file>
   <dotted.path> <value>` changes a `data:` value (it rejects leaving a `{{...}}` unresolved).
   **Other ways to start the task** (card `paths:`, the brief's "Several ways to do one thing"):
   one walkthrough, not one per way. `aida inspect` each way's start page, then add a `paths:`
   entry (cheat sheet → "Several ways to do one task"): `start.page`, opening steps (each with a
   `say`: they narrate the path's own short clip), `joins:` (the main step where it meets the
   shared rest) and a `when:` sentence from the brief. Edit with `aida edit addPath`/`setPath*`.
4. **Demo data and state**: invented values through example.com/reserved phone ranges (see
   `references/safety.md`), written into `data:` directly when authoring, or via `aida edit
   setData` on a repair. A walkthrough that changes data declares it (from the card):
   `needs`/`leaves`/`clears` with kebab-case state names, and unrecorded `setup:` steps for data
   only it uses (`references/walkthrough-cheatsheet.md` → "Data this walkthrough needs and
   changes"). `{{run.id}}` goes in `setup` data only, never in typed text, `say`, `caption` or
   `page_text`. Starting data shared across walkthroughs is a config state hook: hand off to
   `aida-demo-data`.
5. Validate: `aida validate <file> --config <cfg>` (the config's `states` are checked against
   `needs`/`leaves`/`clears`; caption and chapter line lengths too). Fix what it reports yourself.
6. Capture: `aida capture <walkthrough-id>` (add `--with-deps` when it needs a state another
   walkthrough leaves). It replays the main steps, then each path, in a real browser and writes
   `manifest.json`/`validation.json`/`failure.json` to the build dir. **Never run two at once**:
   captures share one app/db. When the router writes several walkthroughs in parallel, it runs
   them one at a time (or as one `aida capture a b c`) after every subagent's YAML is ready.
7. **If capture fails**, read the report's `category`. `app` or `environment`: report it to the
   router with the `reason` and `changes` evidence, and don't change the walkthrough to get past
   it (decision 30). `walkthrough`: hand off to `aida-repair` with just the trimmed failure
   report — don't try to fix it yourself by re-guessing locators; that's `aida-repair`'s job.
   Skipped as blocked: report the provider it names; this walkthrough isn't the problem.
8. On success, report back to the router: walkthrough id, pass/fail and step count, not the full
   YAML or capture output. After the first passing capture of a task that saves, run `aida paths
   <id> --config <cfg> --json` (other screens making the same save); ask the person before
   adding any as a path. A capture warning "path X saves differently": confirm what with the
   person, then set a short neutral `note` (`aida edit setPathField <file> <pathId> note "..."`).

## Writing rules

- Plain words, on-screen names, per `references/style.md`. No invented buttons or results — only
  what the capture actually showed (write a first draft from the card, then correct it against
  the capture result once it runs).
- Use the brief's words exactly, never their "not to be confused with" twins. In `page_text`,
  say when and why as well as which button: the rule that applies, the state a save moves
  things to, which of several ways to start suits the reader (from the brief, never invented).
- When the card and the screen disagree, follow the screen. Capture records a renamed label on
  the card by itself. Note anything it can't see, such as a button that isn't there at all:
  `aida outline note <id> 'No "Register again" button' --config <cfg>`.
- Never a production write step without explicit sign-off (see `references/safety.md`).
- Keep `say`/`caption`/`page_text` distinct per the style guide, not one copied into all three.
- After a save, don't assume it navigates (`waitForUrl` fails forever if the save updates the same
  page): run `aida inspect --walkthrough <id> --after <saveStepId>` and write a `waitFor`/`expect`
  against what changed (a toast, a heading, the dialog closing). Nothing changed: report a bug.
- `highlight: true` goes on the action whose target the doc screenshot shows — never on a click
  that navigates away; put it on the `expect`/`waitFor` after the navigation instead.

## Token rules

See `references/tokens.md`. You see only this one walkthrough's card and capture report — never
another walkthrough's files, and never the full app digest.
