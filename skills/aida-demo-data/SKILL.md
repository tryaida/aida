---
name: aida-demo-data
description: Create demo data for a walkthrough through the app's own screens or API — setup steps and config state hooks, never direct database writes unless an engineer explicitly asks for a seed script. Use when a walkthrough needs data that doesn't exist yet (a competitor, a show, a class) before capture can run, or must capture cleanly twice.
---

# aida-demo-data

Model tier: **standard**. Writing a small script or a sequence of app actions needs care, but it's
routine once the shape of the data is known from the outline card.

## Default path: through the app itself

1. **Data only one walkthrough uses** (a second competitor to pick from): its own `setup:` steps,
   in the same `do:`/`check:`/`actions:` grammar as `steps`, run before capture and never filmed.
   `setup: { as: admin, steps: [...] }` signs in as another role for them.
2. **Starting data several walkthroughs need, or that no walkthrough leaves** ("Alex is in the
   morning block"): a config `states` entry with hooks, put in through the app's own API
   (decision 15), never the database:

   ```js
   states: {
     "alex-in-morning": {
       description: "Alex is in the morning block",
       as: "admin",                                  // the hooks' own signed-in session
       setup: "./states/alex-in-morning.mjs",        // its `setup` export, else default
       check: "./states/alex-in-morning.mjs",        // its `check` export, else default
     },
   },
   ```

   Hooks get `ctx.request`, an API client carrying the signed-in session (relative paths resolve
   against `baseUrl`), plus `ctx.page`, `ctx.runId` and `ctx.env`. `check` returns true when the
   state already holds and changes nothing. `setup` must be idempotent ("make sure it's so"): it
   runs on every capture that needs the state, so it may first delete an earlier run's copy.
   Without `as:` the hooks share the walkthrough's own session; a hook that signs in through the
   API needs `as:` set to a different role, or it signs the recording out.
3. **Records setup creates that must not collide** across runs: name them with `{{run.id}}` in
   setup data (`ctx.runId` in a hook). Never let it reach typed text, narration or captions:
   screenshots would change every run.
4. All values follow `references/safety.md`: `@example.com` emails, reserved fictional phone
   ranges, invented names. Never copy a real record, even with names changed, as a starting point.
5. Use a dedicated demo account or workspace where the app supports one, never a production
   account. Quick mode (no dedicated demo env) asks the person before saving anything.

## Seed scripts: only on explicit engineer request

- Write a direct-to-database seed script only when an engineer asks for one by name (e.g. "write
  a seed script for the demo DB"). Default users and vibe coders never get one — the whole point
  is AIDA needs no database access.
- If you do write one: it targets only a database capture's own safety check accepts (on this
  machine, or a branch the person named as throwaway; `aida doctor` shows which), it uses
  the same safe demo-data values, and it lives with the app's own seed tooling, not inside a
  walkthrough file.

## Rules

- Never create data as a side effect of a step marked read-only in a walkthrough. If a
  walkthrough needs setup data, make that explicit (`needs`, `setup:`), not hidden state.
- Never add cleanup steps to a recorded walkthrough. A walkthrough that removes data says so with
  `clears`; a re-run gets its starting data back from an idempotent setup hook or the database
  reset.

## Token rules

See `references/tokens.md`. Small, targeted: the one card's data shape, not the whole schema or
app.
