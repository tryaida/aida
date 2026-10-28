# Discussion log

How the idea developed, in order. The current state of the plan is in [scope.md](scope.md); this file
keeps the reasoning and the details that didn't make it into the scope.

## 2026-10-22 — first planning session (Claude Code)

### 1. The ask

Build a repeatable agent framework that generates user-facing documentation for a solution. Point it
at the app repo, the running app and any other context, and it generates a well-organised doc site
with:

- doc pages that can be printed
- narrated tutorial videos like the ones an existing pipeline already made for a pilot app
- an AI chat over the documentation
- an MCP server agents can connect to

It should be agnostic: work with Claude, Codex and others, and with many AI voice providers. The
initial guess was "a bit of skills, code snippets, but also some ready-built scaffold".

### 2. First response: all three, weighted to the scaffold

- **Deterministic CLI, thin skills.** The CLI does capture, render, TTS, indexing, publishing and QA,
  so any agent with a shell can drive it. Skills do the judgment work: read the repo, work out who
  the users are, plan the site, write narration, fix broken selectors. Prompt-only pipelines give
  different results every run.
- **Pipeline:** `init → discover → plan → capture → render → index → publish → verify`.
- **Scaffold contents:** workflow schema (JSON Schema), Playwright capture runner with cursor and
  highlight overlays, video composer with that pipeline's fixes baked in (BT.709 limited range, −16 LUFS,
  black-frame check, caption timing from TTS durations), doc site template with print styles,
  chat and MCP sharing one index, provider adapters behind small interfaces:

  ```ts
  interface TTSProvider {
    synthesize(text: string, voice: string): Promise<{ audio: Buffer; durationMs: number; wordTimings?: unknown }>;
  }
  // plus LLMProvider (OpenAI-compatible + Anthropic), EmbeddingProvider, VectorStore (SQLite + sqlite-vec default)
  ```

- **MCP tools proposed:** `search_docs`, `get_page`, `list_journeys` (now `list_walkthroughs`),
  `get_procedure(journey)` returning structured steps.
- **Demo-environment contract:** the hardest part. The app provides a `seed` command with fake data,
  a `start` command, an auth bypass for a made-up user, and outbound email/cloud turned off. The
  framework enforces PII and secret scans and refuses non-localhost capture without an override.
- **Language:** TypeScript, since Playwright, the video tooling, Astro and the MCP SDK are Node-based.

### 3. Added: CI/CD so docs auto-update

- **Triggers:** PR opened (check affected walkthroughs, screenshot diffs as a PR comment, preview
  link, no video); merge to main (regenerate and publish "latest"); release tag (frozen version);
  nightly (drift, links, assets).
- **Incremental:** impact map from what each step touched; content-hash caching (narration audio,
  screenshots under a diff threshold, videos only when a scene changed); determinism (pinned fonts
  and Chromium in Docker, fixed viewport, frozen clock, seeded data, animations off).
- **Three tiers:** cosmetic (auto-publish), broken (headless agent repair via `claude -p` /
  `codex exec` or a clear failure, opens a docs PR), new feature (agent drafts a walkthrough, PR
  labelled `docs:new`). Meaning changes always get human review.
- **Packaging:** GitHub Action, GitLab CI template, generic Docker image; demo env as a
  `docker compose` service (Docker later dropped as a requirement — see step 8); a `ci:` section in `aida.yaml` (agent, budget cap, auto-publish tiers,
  publish target).
- **Where things live:** source (config, walkthroughs, overrides) in the app repo under `docs/`;
  generated MP4s, PDFs and screenshots in artifact or object storage, not git; atomic index swap.
- **Security:** keys as CI secrets; fork PRs get no secrets and run deterministic checks only.
- **Example workflow sketched:**

  ```yaml
  # .github/workflows/docs.yml
  on:
    pull_request:
    push: { branches: [main], tags: ['v*'] }
  jobs:
    docs:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with: { fetch-depth: 0 }
        - uses: aida/action@v1
          with:
            mode: ${{ github.event_name == 'pull_request' && 'check' || 'update' }}
            agent: claude          # claude | codex | none
            budget-usd: 5
          env:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
            TTS_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
  ```

- CI moved up to step 3 of the MVP order because it shapes the cache and impact-map design.

### 4. Existing solutions

Researched the market ([landscape.md](landscape.md)). Conclusion: a real gap. Promptless (text and
screenshots), Videate (video) and Mintlify (site, chat, MCP) each own one piece; all closed and none
starts from the repo plus a seeded demo environment. Open-source tools (Argo, Doc Detective) are
single-purpose. Nobody has one walkthrough file driving docs, video, tests and MCP procedures.

### 5. Focus on vibe coders and low friction → high-level scope

The user's steer: make it non-technical enough for vibe coders, reduce friction, and meet vibe coders
and engineers where they already work. This produced the scope doc
([scope.md](scope.md)). New ideas
introduced at this step:

- **Doors:** agent skill, CLI, GitHub Action, deploy hook (Vercel/Netlify preview deploys), GitHub App
  (Dependabot-style docs PRs for Lovable/Bolt/v0/Replit projects synced to GitHub), web app,
  generator MCP server, DeepWiki-style URL swap for public repos.
- **Ask at most three plain questions;** infer everything else; plain product words.
- **Capture ladder:** quick (live URL + test login, read-mostly, masked) → safe (preview deploy or DB
  branch with agent-written demo data) → CI (throwaway env per run).
- **Evidence rule:** nothing documented that wasn't seen working; "last checked" on every page.
- **Brand extraction:** site theme from the app's own colours, logo and fonts.
- **In-app help widget** that knows the current screen; unanswered chat questions become suggested
  walkthroughs.
- **Approvals where people are:** PR review for engineers, email/Slack approve buttons for vibe
  coders, `@aida` mentions.
- **Phases 0–5 with gates;** v1 = Phases 0–3.

### 6. Added: user editing, modelled on HyperFrames

The user asked for editing options "kind of like how HyperFrames goes about it". From the HyperFrames
skills installed locally (`hyperframes-studio`, `hyperframes-cli`, `hyperframes-core`
`creator-editing-recipes.md`, `hyperframes/references/review-loop.md`), the patterns taken:

- one open source format edited by hand, by the agent, or in the Studio — all round-trip
- Studio timeline with one row per kind, so non-editors can read it
- selection-aware agent: it queries what the user selected instead of guessing
- undoable history attributed to person or agent; agent reads the person's changes since its last
  turn and builds on them; undo the agent's turn without touching the person's edits
- fixed edit recipes so every surface makes the same edit the same way
- plan → sketch → build → final preview review loop; locked items are never overwritten
- approved runs frozen as reusable recipes ("like last time")
- hand-off to an app and `catch-up` afterwards

AIDA's twist: edits are stored as intent on walkthroughs (callouts pinned to elements, hold times),
so automatic rebuilds keep them. Added an Editing section, a Studio risk, and a timeline decision.

### 7. Project folder created

Created the project folder with these docs. While writing them, checked the pilot app's pipeline and found it
renders with its own HTML player and FFmpeg, not HyperFrames. The scope was corrected and "Video
renderer" added as an open decision.

### 8. Simplicity: drop Docker, deploy anywhere

The user questioned Docker, since most target apps are Next.js or similar. Agreed: Node becomes the
only runtime (decisions 14–16).

- **What Docker was doing and its replacement:** pinned browser → pin the Playwright version;
  stable screenshots → fixed viewport, locale and time zone, `page.clock`, reduced motion, publish
  only from one CI runner type; FFmpeg → `ffmpeg-static`; running the app → the PR's preview URL
  (Vercel and Netlify report it to GitHub via `deployment_status`; protected Vercel previews need the
  automation bypass header) or Playwright's `webServer` running `npm run dev`; seeded DB → demo data
  created through the app's own screens or API, optional Supabase/Neon branches; sign-in → test
  account once, saved `storageState`, helpers for Auth.js, Clerk, Supabase Auth, Firebase.
- **Next.js bonuses:** file-system routes make Discover easy; the help site can live inside the app
  at `/help`, deployed with it, with the in-app widget reading the current route (default later
  changed to a separate help app — see step 9).
- **Deploy anywhere** (the user asked for Amplify, Vercel, etc.): output is a static help site
  (Pagefind search built in) plus one portable fetch-style function for chat and MCP (e.g. Hono), so
  the same code runs as a Next.js route, Vercel or Netlify Function, Lambda, Cloudflare Worker or
  Supabase Edge Function. `aida publish --to <host>` writes host config. Videos go to the host's
  blob storage when too big (Cloudflare Pages caps files at 25 MiB).
- Docker stays optional: used only if the app's repo already runs on `docker compose`, and inside
  AIDA Cloud where users never see it.
- Name: the working name stays for now; the user will think of a better one (AIDA, chosen 2026-10-26).

### 9. The help app is a prescaffolded Next.js project; Studio runs locally

The user's model: the coding agent and its environment do most of the work, and the output is a
prescaffolded Next.js project that deploys easily, with the Studio running locally in the coding
environment. Agreed, with two refinements (decisions 16–19):

- **Who does what:** coding agent + skills = judgment; AIDA engine (npm) = capture, voice, video,
  PDFs, index, checks, in the coding environment or CI; the scaffolded Next.js help app = site,
  chat, MCP, Studio; the host = plain `next build` (no Playwright or FFmpeg there).
- **Next.js replaces Starlight + a separate function:** chat and MCP become Next.js routes, so one
  project and one deploy. Vercel, Amplify and Netlify support Next.js natively; Cloudflare via the
  OpenNext adapter; static export for GitHub Pages or S3 (site and search only). Fumadocs is the
  candidate docs layer.
- **Separate help app by default,** not merged into the user's app (this replaces step 8's "/help
  inside the app" default). `yourapp.com/help` via a host rewrite or Next.js multi-zones.
- **Studio:** dev-only `/studio` route, edits repo files directly (Keystatic/TinaCMS precedent),
  never in the production build. Remote environments forward the dev port (as with HyperFrames on
  this server); sandboxes that can't expose ports run the Studio on a preview deploy behind sign-in,
  committing to GitHub — which is also the Phase 4 hosted-Studio path.
- New risks: the scaffold falling behind Next.js releases (thin app, logic in the engine,
  `aida upgrade`); the Studio being unreachable from some sandboxes.

## 2026-10-22 · Token efficiency, model tiers and subagents; build starts

The user added token efficiency to the spec: use the right model for each part of the process and
use subagents. Added "Token efficiency, models and subagents" to scope.md (decisions 20–21): model
tokens only for judgment, fast/standard/deep tiers mapped per skill (Anthropic defaults Haiku 4.5,
Sonnet 5, Opus 5.5), Discover fanned out per app area, one subagent per walkthrough for write and
repair, small engine outputs (`--json`, trimmed failure reports, `aida digest`), prompt-cache
friendly ordering, per-run token report and budget. The user asked to start building in a loop with
subagents, using the first pilot app as the test repo; plan in build-plan.md.

## 2026-10-23 · Build round 2: M10–M15, second app, first-capture rate

Built render per scene, faster capture, PDFs, `aida publish`, help chat and agent connector, and
proved AIDA on a second app (a pnpm monorepo). Two Opus reviews found and closed
safety holes (agent self-approval of publish, unescaped PDF HTML, spoofable chat rate limit,
fail-open masking). Measuring the spec's first-capture target drove a new `aida inspect` command
(a signed-in, read-only accessibility map of a page, ~450–600 tokens versus ~4,900 to read the
page's source) and label short-name matching: first-capture pass rate went 2/5 → 1/5 → 7/8 (88%)
across both pilot apps. Details in build-plan.md.

## 2026-10-25 · Phase 2 wave 1; CI without keys; going public

Built M16 (cold draft render 174 s → 59 s, quick reference card 1.78 MB → 65 KB), M17 (`aida
affected`: import graph from routes; 9 of the pilot app's last 12 commits mapped precisely), M20
(Playwright test import) and M21 (versioned docs, What's new). For M18/M19 the user decided: no
model API keys and no dollar budget cap — all judgment through Claude Code, with CI doing only
deterministic work plus an optional Claude Code GitHub Action on the user's subscription;
screenshot diffs on an orphan branch, no preview deploys yet; docs PRs reviewed by the app PR's
author with a `docs:new` label; help chat off until an owner adds a key. AIDA goes public on
GitHub (owner configurable per user); the first pilot may add the docs workflow to its
own repo. Material copied from private apps (the original pipeline snapshot, the second app's
example) stays local and out of the public history. Decisions 22–25.

## 2026-10-26 · Polish, brand and library hierarchy

The user asked for a much more polished doc site and Studio, every output in the origin app's
brand, and hierarchy in the doc library. Built as M23: brand detection reads the app's colours
(light and dark), accent, radius, font and logos into generated theme files; the site, Studio,
narrated videos, PDFs and the drop-in chat widget all read them. Walkthroughs gain `section:`, and
pages now sit in the scope.md categories with section pages and nested URLs (old links redirect).
The site gained a home page with search and topics, card grids, a richer guide header, video
chapters and a ⌘K search; the Studio a branded shell, library by section, step cards, a real page
preview and video tab. Decision 26.


## 2026-10-26 · Lessons from the first outside run

The user ran AIDA on a separate app (Next.js + Auth.js + Neon) and shared what the
run taught. Biggest lesson: a local web address isn't local data. The app ran on `localhost` but
wrote to the live Neon `main`, and AIDA's write guard only checked the URL; the run was made safe
by hand with a Neon branch, a wrapper that refused the live database and email set to dry-run.
Other lessons: walkthroughs depend on each other's data and the capture order lived only in the
orchestrator's head; captures found a real app bug; persona fields disagreed between commands;
QA line-length failures came only after voice and render; setup friction (unrelated npm package
for `"aida": "*"`, engine build before import, Turbopack and symlinks, dev-server cache filling
the disk, tunnel hosts). Verified each claim against the code, then planned M24–M29 and decisions
27–30: database check bound to an exact throwaway host, `aida doctor`, a packed engine tarball,
one persona everywhere with reader names, data dependencies with states and setup hooks,
classified failures with app bugs reported separately, `inspect` past a submit, and outline drift.

## 2026-10-26 · Renamed to AIDA; app-neutral before going public

Renamed docgen to AIDA (Agent-driven Instruction and Documentation Automation): CLI and package
`aida`, config `aida.config.ts`, env `AIDA_*`, skills `aida`, `aida-discover`, `aida-plan`,
`aida-write`, `aida-repair`, `aida-review` and `aida-demo-data`. A clean break: no compatibility
shims for the old `docgen` names, since nothing had been published under them. To keep the
public repo app-neutral, the pilot-app example folders, the import command for the first pilot's
legacy format and the origin doc were removed, and the docs now describe the pilot apps without
naming them. The README was reworked around "Turn your app into user guides and narrated tutorials."
Decision 31.

## 2026-10-27 · Recording a walkthrough ("Show me")

The user asked how AIDA could record a workflow. Two routes were weighed: wrap Playwright's own
codegen and feed it to the existing Playwright importer, or build AIDA's own recorder. The user
asked for the best way, so the recorder was built now as `aida record` rather than waiting for
Phase 4. It runs on capture's own runner, so a recording starts exactly as a capture would (safety
gate, sign-in, `needs` setup, viewport), and it checks each target with capture's `locate()` while
the element is still on screen. A toolbar lets the person point at things, mark what should be
showing, add the step's narration in their own words, break steps and undo. Typed values become
safe demo data and passwords are never kept. The output is only a draft; the draft is replayed
once. The hosted Studio version stays in Phase 4. Decision 32, M30.

## 2026-10-27 · Understanding the app, several ways to do a task, and polish

The user asked how to improve output quality and named three things: PDFs, videos and other
outputs should match the documented app's brand; the agent writing scripts needs better context
about what the app is for; and the agent should learn the different ways a task can be done (a
payment can be recorded against one entry, against the competitor, or from the Payments screen).
Brand was already wired into every output (M23), but detection read only the repo, and the outputs
were on-brand yet plain. Discover saw routes and labels, never purpose, and each walkthrough had one
path. Rebuilding a pilot's PDFs with the current engine showed the print gaps: full-width shrunk
screenshots greyed by the spotlight, half-empty pages, a lone "Part 1" heading, tiny card
thumbnails and Type 3 fonts. Agreed: an Understand step writing `app-brief.md` with a domain model
from the schema (decision 33, M31); walkthrough `paths` with `aida paths` finding other screens
that call the same captured action (decision 34, M33); brand read from the running app, style
presets and a proof sheet (decision 35, M34); and a designed-manual standard for print, which the
user asked for explicitly (decision 36, M32). Order: M31 and M32 first, in parallel.

## 2026-10-28 · Interviewing the builder

The user asked for an interactive version in which the agent interviews the builder in depth
about workflows, readers and the nuances of how the app is used, so the help is relevant to the
people who actually use it. The Understand step already wrote a brief from the repo and asked three
to five open questions, but a repo can't say who opens the app on a phone at a busy venue, how
confident they are, what happens outside the app between two tasks, or what people ask the builder
for help with. Agreed: keep the quick path, and offer an in-depth interview beside it (decision 38,
M40). The engine decides what's worth asking, the same way every time (from the brief, the config's
roles, the domain model's states and the outline), and keeps the answers in `app-interview.yaml`
so nothing is asked twice; the skill does the conversation in the main session, since a subagent
can't talk to the person: a topic at a time, stories rather than opinions, follow-ups, a playback
every topic, and stopping whenever the person wants. Readers are described by their needs
(devices, confidence, reading level, accessibility, connection, time pressure), never by age,
gender or health. Answers land in the brief as a reader profile and two optional sections,
Workflows and Where people get stuck, which planning, writing, the agent connector and a new
Common problems page (so the help chat finds them too) use.
