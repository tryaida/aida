---
name: aida-review
description: Review finished AIDA output — page text tone, screenshots, the QA report, and personal-data risk — without seeing the reasoning that produced it. Runs in a fresh-context subagent so it judges the result, not the author's own justification. Use before any publish, and whenever a person asks "does this look right".
---

# aida-review

Model tier: **standard**, in a **fresh subagent context** — it must not inherit the writer's or
planner's reasoning or chat history, only the finished artifacts. That separation is the point:
a reviewer that saw the author's justification tends to agree with it.

## Input

Only the output, never the conversation that produced it:

- Rendered page text (Markdown from `aida pages`).
- Screenshots / video stills.
- The QA report (`aida qa <path>`): video, captions, personal-data, and secrets checks.
- `aida outline list --drift` output: names a card promised that the screen didn't have.
- Each walkthrough's `validation.json` `pathDiffs` (paths that save differently), if any.
- The app brief's words and rules: `aida brief show --config <cfg> --section "Words it uses"
  --section "Rules that matter"`. The brief is a finished artifact, not the writer's reasoning.
- Nothing else — no walkthrough-writing chat, no discover/plan summaries.

## What to check

1. **Tone**, against `references/style.md`: plain words, correct vocabulary ("walkthrough" not
   "journey", no exposed internal terms), bold on clickable labels, no invented features.
2. **Screenshots**: legible, nothing cut off mid-action, no stray cursor/hover states that confuse
   the step.
3. **QA report**: did it pass? If not, what failed — don't re-run QA yourself, just read its
   result and surface it.
4. **Personal data**: does any screenshot, caption, or page text show a real-looking name, email,
   phone number, or anything not on the example.com/reserved-range list (see
   `references/safety.md`)? Treat anything ambiguous as a fail, not a pass.
5. **Screen versus words**: page text naming a label from the drift list instead of what the
   screenshot shows is a finding. A screenshot showing an error, a blank page, or a save that
   left the screen unchanged is a possible app bug: report it as one for a person, not as a
   wording fix.
6. **Words and rules**, against the brief: a page using a "not to be confused with" word instead
   of the app's own, contradicting a rule, or leaving out a rule that changes what the reader
   should do (a payment that can't be undone). A page that says only which button, never when or
   why, is a finding too.

7. **Other ways to do this** (walkthroughs with `paths:`): every path is in the page's "Other
   ways to do this" section with its own screenshots, none marked not verified; each `when`
   sentence says when to pick that way, not just where it starts. A path capture flagged as
   saving differently (`pathDiffs` in the walkthrough's `validation.json`, or a "saves
   differently" warning) needs a short neutral note on the page that says what happens, and
   nothing speculative: missing or guessing is a finding. Path screenshots get the same
   personal-data check: a path step needs its own blur/mask.

## Output

A short verdict per walkthrough/page: pass, or a list of specific findings (quote the offending
text/field, don't paraphrase it away). No rewriting — hand findings back to `aida-write` or
`aida-repair` to fix; review doesn't edit.

## Rules

- Never wave something through because "the capture passed" — capture proves the steps work, not
  that the words or images are fit to publish.
- First publish always needs a person's OK regardless of review's verdict (see
  `references/safety.md`) — review informs that decision, it doesn't replace it.

## Token rules

See `references/tokens.md`. Fresh context, output only — this is the one skill that should never
see another skill's working notes.
