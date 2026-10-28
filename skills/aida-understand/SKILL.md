---
name: aida-understand
description: Write the app brief (app-brief.md) — what the app is for, who uses it and the job they're doing, the things it keeps track of, its words, rules, rhythm, and tasks that start from more than one screen. Use after aida-discover and before aida-plan on a new app, or when the brief is missing, stale, or fails aida brief check.
---

# aida-understand

Model tier: **deep**. Runs once per app, after `aida-discover` and before `aida-plan`. Every later
skill, the help chat and the agent connector read the brief, so a wrong guess here spreads
everywhere: infer carefully, and say what you're unsure of.

## Input

The merged discover summary (routes, roles, labels, likely tasks) and the config path. Not the
app's source tree.

## How

1. **Domain model.** `aida domain --config <cfg>`: one line per thing the app keeps track of,
   with its states and links. Zoom with `--entity <name>` only for the few that matter.
2. **Sources.** `aida brief sources --config <cfg>`: the app's own prose, best first, with
   headings. Read only the top few that answer "what is this for and who uses it": the README, a
   user guide, the landing page, seed data. Read a file's relevant section, not the whole file,
   and skip implementation notes unless they explain a business rule.
3. **Skeleton.** `aida brief init --config <cfg>` writes `app-brief.md` beside the config with a
   prompt in every section and "Things it keeps track of" started from the domain model. Never
   pass `--force` over a brief a person has edited.
4. **Fill every section** in plain words (`references/style.md`), replacing each prompt:
   - Frontmatter: `app`, `updated` (today), and one `readers` entry per role discover found,
     `{role, name, job}`: the role id, what people call them, the real-world job they're doing.
   - **What it's for**: the first paragraph is the help site's home page intro: one or two
     sentences, no jargon.
   - **Things it keeps track of**: rewrite the domain lines as the people who use the app see
     them; say what moves each thing from one state to the next. Drop bookkeeping tables.
   - **Words it uses**: the screen's own words (from discover's labels), with "not to be
     confused with" for near-synonyms. Writers use exactly these words.
   - **Rules that matter**: what can't be undone, limits, deadlines, money; one bullet each, why.
   - **Rhythm**: the daily or seasonal flow, if the app has one.
   - **Several ways to do one thing**: cross the domain model with discover's routes. An action
     on a child thing (a payment on an entry) can usually start from the child's screen, the
     parent's screen (the competitor) and a list screen (Payments). List each such task with
     every starting screen and when you'd use it. These feed the outline cards' `paths:`.
5. **Ask only what you can't infer.** Put every uncertainty under "Open questions" and return
   the 3–5 that change what the help says (who can refund?); don't ask what the repo answers.
   Run as a subagent you can't ask the person: the router asks them before planning (or runs
   `aida-interview`, which asks them with everything else) and moves each answer into its
   section. "Open questions" is never published, so no answer stays there.
6. **Check.** `aida brief check --config <cfg>` until it passes, and replace every section's
   prompt. `aida build` won't publish a brief with errors, personal data or prompts left; the
   rest is published (help chat, agent connector): no real names, emails or phone numbers
   (`references/safety.md`).

Return to the router: the brief's path, the readers, and the open questions. The router shows
the brief with the outline at **checkpoint 1**.

## Updating

When a big feature lands, re-run steps 1–2 for what changed, edit only the affected sections,
bump `updated`, and run `aida brief check`. Don't rewrite a section a person has edited without
saying so.

## Token rules

See `references/tokens.md`. `aida domain` and `aida brief sources` are a few thousand tokens
for a 40-table app; read at most a handful of sources, by section. Keep the brief under about
4,000 tokens: every writer loads parts of it, and the help chat sends three sections with every
question.
