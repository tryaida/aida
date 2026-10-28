---
name: aida-repair
description: Fix one walkthrough after a failed capture (broken locator, changed label, failed check) and re-run capture for just that walkthrough. Reads only the trimmed failure report, not the full page or logs; stops and reports a suspected app bug or environment problem instead of editing. Escalates to aida-plan's deep tier after two same-step same-cause failures or 5 total attempts. Use when AIDA capture reports a failure, or CI flags a walkthrough as broken.
---

# aida-repair

Model tier: **standard**; **escalate to deep** (hand off to `aida-plan`, which carries the deep
tier) after **two failed tries on the same step with the same cause**, or **5 total attempts on
one walkthrough**, whichever comes first. "Two failed tries" means the *same* step failing twice
for the *same* reason — a different step failing afterward is progress, not a repeat, and resets
the same-step counter; keep going on it up to the 5-attempt total. Hitting either threshold means
the problem is likely a real planning question (the task changed shape), not a locator fix.

## Input: the trimmed failure report, plus one scoped `aida inspect`

Read exactly what the engine's capture step writes — the failing step's id, the error, its
`category` and `reason`, a `changes` block saying what the step did, and a trimmed accessibility
snapshot of the page at the point of failure, from `failure.json` in the
capture dir (`.build/<id>/capture/failure.json`, the same trimmed `FailureReport` `aida capture
--json` prints). When `AIDA ci` flagged the walkthrough as broken, its PR comment and repair
command give the exact path instead — it's `.build/<id>/ci/capture/failure.json` there (a
separate capture dir from local `aida capture`, so a CI run never clobbers a person's own last
local capture) — use the path the comment/command gives, not the default above. Then run one
`aida inspect` on the failing page, scoped with `--area` where the failure report already
points (step 2 below) — its ~80-line cap is the only other read this skill does. Never the full
page HTML, console log, video, or the rest of the app.

## How

0. Run `aida catch-up --since last` first — a person may have fixed or relocked the same step
   in the Studio since the last time an agent looked.
1. Read `category` and `reason` first (decision 30). `changes` is the evidence: URL before and
   after, write requests and their statuses, error responses, page errors, blank page, who was
   signed in, and which action failed after which one worked.
   - **`app`** (a 5xx, an uncaught page error, a blank page, or a save that returned 2xx while the
     screen stayed the same): **stop**. Don't edit the walkthrough: no extra wait, no `goto` past
     the screen, no looser check. Report to the person: walkthrough, step, `reason` and the
     `changes` evidence, as a suspected app bug. If the snapshot shows the classification is
     wrong, say what you saw and still let the person decide.
   - **`undetermined`** (the save worked but the target never showed, and the diagnosis-only
     reload couldn't check because the page needs to send over its live connection): treat it
     like `app`: **stop** and report it to the person with the `changes` evidence; don't edit the
     walkthrough unless they say it's the walkthrough's.
   - **`environment`** (app unreachable, browser won't start, sign-in, a setup hook, a safety
     refusal): fix the setup, not the steps. Run `aida doctor`; a sign-in failure is the
     sign-in adapter or the persona's demo account; a failing `setup:` step in this file is
     yours to fix, a config state hook is reported with the fix. A safety refusal goes to the
     person (`references/safety.md`); never set a database opt-in yourself.
   - **Blocked** (`capture:blocked` in `report.json`, or "skipped: needs <state>, which
     <provider> didn't leave"): it never ran. Repair the provider instead (or report it, if it's
     a possible app bug). No provider at all, or a cycle, is a plan gap: escalate.
   - **`walkthrough`**: carry on. A 4xx `reason` usually means a required field the walkthrough
     never fills, or demo data the app rejects (step 4).
   Then read the one failing step and its target. Compare the target (`role`/`name`/`label`/`text`)
   to what the accessibility snapshot actually shows at that point.
2. Before editing, run `aida inspect <failingPage> --config <cfg> --json` on the failing page —
   scoped with `--area` to the relevant landmark/dialog when the failure report's snapshot
   already shows where (e.g. `--area dialog`, `--area main`) — rather than trusting a guess at
   the new role/name/option label. This is the same ground truth `aida-write` uses; a wrong
   role guess (button vs link), an inexact `<select>` option label, or a required field the
   walkthrough never fills are the most common first-capture failures, and `inspect` shows all
   three directly instead of re-reading the failure snapshot's trimmed text by eye. When the
   failing page is one you only reach by saving, `aida inspect --config <cfg> --walkthrough <id>
   --after <stepBeforeTheFailingOne> --json` replays the walkthrough's real steps (it writes, like
   capture) and scans the page they leave.
3. Fix the smallest thing that explains the mismatch: a renamed label, a changed role, a step that
   needs a `waitFor` first, or a target that needs `within`/`exact` to disambiguate. A step
   missing entirely (the failure is really "nothing to click" — an unscripted required field or a
   skipped confirmation step) gets a new step via `insertStep`, not a bigger `actions:` list
   bolted onto a neighbour:
   ```
   aida edit insertStep <file> --after <stepId> --id <newId> --do 'fill "Phone" with "{{competitor.phone}}"' --say "Add their phone number." --by agent --json
   ```
   Don't rewrite steps that didn't fail. Never a raw file edit — always through `aida edit`, which is
   lock-aware (refuses/flags a locked step instead of overwriting it) and records the change in
   edit history, so `undo` and `catch-up` both see it:
   - A plain-words `do`/`check` fix (the common case — a renamed label, a role change, swapping
     `click "X" button` for the right wording):
     ```
     aida edit setStepField <file> <stepId> do 'click "Add competitor" button' --by agent --json
     aida edit setStepField <file> <stepId> check 'text "Competitor added" is visible' --by agent --json
     ```
     The value is validated by parsing it the same way the walkthrough parser does — an
     unrecognised phrase is rejected (nothing written) with a short error, not a silent no-op.
   - A fix plain words can't express (`within`/`exact` to disambiguate, a `waitFor` with
     `snapshot`, multiple actions on one step): replace the step's whole `actions:` list with
     `setStepActions`, given a JSON array in the same shape as `actions:` in YAML:
     ```
     aida edit setStepActions <file> <stepId> \
       '[{"do":"click","target":{"role":"button","name":"Create Competitor","exact":true}}]' \
       --by agent --json
     ```
     This is schema-validated the same way (rejects, without writing, on the first invalid
     entry) and replaces the whole list — include every action the step needs, not just the one
     that changed.
   - Run `aida edit --help` for the exact syntax of every action (`setStepField`,
     `setStepActions`, `insertStep`, `reorderSteps`, `removeStep`, `setPageBlock`, `lock`/`unlock`).
4. A duplicate/unique-constraint rejection on a retry is usually the last attempt's saved data,
   not a locator problem: say so. Don't fix it with a new typed value every run (it changes the
   screenshots); the walkthrough `needs` a state whose config setup hook clears the earlier copy,
   or the database adapter resets before it. Missing one is a setup gap to report.
5. Validate the file, then re-run capture for **only this walkthrough**
   (`aida capture <walkthrough-id>`) — never the whole set.
6. Pass → report back pass + what changed, one line. Same step fails again for the same reason →
   that's try two on it — try once more with the new failure report. Same step fails a **second**
   time (same cause), or this walkthrough hits **5 total attempts** → stop; hand off to
   `aida-plan` with every failure report so far and a one-line note on what's unclear. A
   *different* step failing doesn't count against the same-step limit — it's progress — but still
   counts toward the 5-attempt total.

## Rules

- Keep edits inside this one walkthrough file. A repair that seems to need touching another
  walkthrough or the site layout is a planning problem — escalate, don't spread the edit.
- Respect locks: `aida edit` already refuses to overwrite a locked step, but if it does, suggest
  the change in your report instead of forcing it (see `docs/scope.md` → "How edits stay safe").
- Never loosen a `check`/`expect` just to make capture pass — that hides a real break. Never work
  around a suspected app bug in the walkthrough (decision 30); it goes to a person.
- If a doc screenshot shows a highlight box over the wrong thing, check whether `highlight: true`
  sits on a click that navigates away — move it to the `expect`/`waitFor` after the navigation so
  it highlights what that screenshot actually shows.

## Token rules

See `references/tokens.md`. One walkthrough, one failure report, one scoped `aida inspect`, in
and out. No app-wide reads.
