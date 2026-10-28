---
name: aida-interview
description: Interview the person who built the app, in depth, about who uses it, their devices and confidence, whole jobs from start to finish, where people get stuck, rules and rhythm, and write the answers into the app brief. Use when the person picks the in-depth interview at the Understand step, asks to be interviewed about their app or users, or when the help reads generic and the brief needs real-world detail the repo can't give.
---

# aida-interview

Model tier: **deep**. Runs **in the main conversation, never as a subagent**: it talks to the
person. Usually after `aida-understand` writes the draft brief and before `aida-plan`; it can
also run later to deepen a brief. The repo says what the app does; only the builder knows who
opens it on a phone at a noisy venue, what they're afraid of breaking, and what they ask for help
with. That's what makes help relevant rather than generic.

## Set up

1. Ask how deep to go, with the time each takes: **quick** (about 10 minutes, the essentials),
   **standard** (about 25, the default), **deep** (45 or more: every thing the app keeps track
   of and every outline card). They can stop, skip or come back any time.
2. `aida interview start --config <cfg> --depth <depth>` writes `app-interview.yaml` beside the
   brief. Rerun it any time (after `aida-plan`, at a deeper depth): it adds new questions, sets
   aside ones that no longer apply (an open question the brief now answers), and never touches an
   answer.
3. Read the brief once (`aida brief show --config <cfg>`) so you never ask what it already says.
4. Tell them, in one short message: why you're asking (help written for their real readers),
   roughly how long, that answers stay in their repo and the help only ever says things in
   general terms, and to leave out real customers' names, emails and phone numbers.

## The loop

Run `aida interview next --config <cfg>` for the next questions (essentials across every topic
first, then detail), then:

- **Ask one topic at a time, one to three questions per message**, numbered so a short reply
  works. Rephrase in your own words and the app's; never paste the guide's wording with its ids.
- **Questions marked "the brief already says something"**: state what the brief says in one line
  and ask what's wrong or missing. Confirming is quicker than asking cold.
- **Ask for stories, not opinions.** "Walk me through the last time a new organiser set up an
  event" gets workflows; "is it easy to use?" gets nothing. Ask for the newest and least
  confident reader as well as the typical one; for numbers (how many, how often); for what
  happens outside the app (the email, the bank transfer, the phone call).
- **Follow the answer.** A surprise, a workaround, "it depends", a second kind of reader, a step
  done on paper: dig with a follow-up, and record it with `aida interview ask --config <cfg>
  --topic <topic> --after <id> --text '<question>'` so the brief gets it. Don't lead ("they find
  it confusing, right?") and don't argue; note contradictions and ask which is true.
- **About readers, ask about needs, not labels**: devices, where they are, how confident with apps
  like this, reading level or English as a second language, eyesight and screen readers, slow
  internet, time pressure. Never ask for or record age, gender, ethnicity or health; record a
  need ("larger text helps"), not the person.
- **Record each answer as it comes**, one command at a time (never in parallel), through a quoted
  heredoc so `$`, quotes and backticks survive the shell:
  `aida interview answer <id> --config <cfg> --text-file - <<'EOF'` then their words, condensed,
  then `EOF`. Keep their words and specifics; drop names, emails and numbers. `aida interview
  skip <id> --config <cfg> --reason '<why>'` when it doesn't apply or they don't know.
- **Every topic or so, play it back** in two or three lines ("So door staff are on their own
  phones, at a queue, and mostly worried about taking cash twice — right?") and fix what's off.
- **Respect their time.** Say how far along you are when moving topic (`aida interview status
  --config <cfg>`). When they want to stop, stop; essentials come first, so a short one helps.

## Write it into the brief

When the essentials are done, or they stop: `aida interview notes --config <cfg> --unapplied`
gives every answer grouped by where it goes. Then edit `app-brief.md`:

- **Readers' frontmatter**: add the profile each answer supports, only when the person said so:
  `devices` (phone, tablet, desktop), `comfort` (`new`, `some`, `confident`), `frequency` and
  `context` (short sentences).
- **Who uses it**: one paragraph per reader, now with where they are, how confident, what they
  need from the help, and the tone the person asked for.
- **Workflows** (add the section after "Rhythm"): each whole job, who does it, the tasks in order,
  the hand-offs and what happens outside the app. **Where people get stuck** (after it): one
  bullet per pitfall, what goes wrong then how to put it right. These are optional sections; add
  them only with real answers. The pitfalls become a Common problems page, which the help chat finds too.
- The rest into its own section; answers from the brief's "Open questions" go where they belong
  and the question is deleted. Plain words (`references/style.md`); everything but Open questions
  is published (help chat, agent connector), so general terms only (`references/safety.md`).

Then `aida interview applied <ids> --config <cfg>` (or `--all`) for what you moved, `aida brief
check --config <cfg>` until it passes, and `aida interview status --config <cfg>` shows `ready`.
Answers that go to `plan` (what to leave out, the three tasks that matter most) stay in the
interview for `aida-plan`, which marks them applied.

Finish by showing the person what changed in the brief, and in one or two lines each, what it
will change in the help: phone readers get phone-sized captures, new readers get fuller steps,
each pitfall becomes a warning at its step, each workflow sets the order of the walkthroughs and
what each page says comes next.

## Token rules

The interview file holds the transcript, so you don't need to keep it in context: after writing
an answer, keep only a one-line summary. Load the brief once at the start; at the end, load only
`interview notes --unapplied` and the sections you're editing. Keep the brief under about 4,000
tokens: condense, don't paste answers in whole.
