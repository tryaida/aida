# Token rules

From `docs/scope.md` → "Token efficiency, models and subagents". Every skill below follows these.

## Spend tokens only on judgment

Capture, render, index, QA and publish are engine code — call them with `Bash`/`npx`, never
simulate what they'd do with a model. If a run's content hash hasn't changed, skip it before
calling any model.

## Load the smallest input that answers the question

- Prefer an engine command's default short summary; add `--json` only when you need to parse a
  field, and only read the fields you need.
- Use `aida digest --area <path>` (an app-area map of routes, roles, labels — see
  `aida-discover`) instead of reading the app's source tree.
- Before writing or repairing a step's target, use `aida inspect <path> --config <cfg> --json`
  instead of reading the app's component source for a page's roles/names/labels/select options —
  it opens the one page signed in and prints a single ~80-line (roughly 600-900 token) capped
  snapshot, versus easily several thousand tokens to read even one non-trivial component file
  (and a source read still leaves the role/label guess unverified against the real DOM). Scope
  further with `--area` on a long page. `inspect --walkthrough <id> --after <step>` prints the
  same capped map, so the same tokens, but replays the walkthrough's real steps first (it writes,
  and takes about as long as a capture up to that step): run it once per save, not per step.
- Measured on a pilot app (first-capture-rate log): `aida inspect` costs **~600 tokens/page**
  versus **~4,900 tokens/page** reading the page's source instead. Log a measured-but-not-exact
  figure like this with `aida usage add --estimate --note "<what it estimates>"` (e.g. the
  per-page inspect-vs-source comparison itself), so a report's real total never gets inflated by
  a guess — `aida usage report` shows estimated tokens/cost separately from real ones.
- On a failed capture, read only the step, the error, and the trimmed accessibility snapshot the
  engine writes to `failure.json` in the capture dir (`.build/<id>/capture/failure.json`) — never
  the full page HTML, console log, or video.
- Load a reference file (this directory) only when the task in front of you needs it, not at the
  start of every run.

## Subagents keep contexts small

- `aida-discover` fans out one subagent per app area; each sees only that area and returns the
  compact summary shape (see its SKILL.md), never the full route tree.
- `aida-write` and `aida-repair` run one subagent per walkthrough in parallel; each sees only
  its own walkthrough file, the style guide, the glossary, and its own capture report.
- `aida-review` runs in a fresh subagent that sees the finished output, not the reasoning or
  chat history that produced it.
- The router skill (`aida`) holds only short summaries from each subagent, never their full
  transcripts.

## Model tiers

Fast = Haiku-class, standard = Sonnet-class, deep = Opus-class (or the nearest equivalent on
whatever provider/model the user's agent runs). Each skill below names its tier; Claude Code
subagent definitions in `skills/agents/` carry a matching `model:` line. When the host agent can't
switch models, every skill still works run on the one model available — see
`skills/agents/codex-note.md`.

## Budgets and caching

- Put stable content first in any prompt you build (style guide, glossary, schema) so provider
  prompt caching applies.
- Report tokens and cost per stage as you go: `aida usage add` after each subagent turn
  (`--stage`, `--tier`, `--model`, `--input`/`--output`/`--cache-read`), then `aida usage
  report` for the run's aggregated token/cost total. Run `AIDA usage add --help` / `AIDA
  usage report --help` for exact flags.
- Stop and summarize instead of continuing once a run looks like it's exceeding a sensible budget
  for the task size; don't silently keep spending.
