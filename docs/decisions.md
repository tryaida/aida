# Decisions

Last updated 2026-10-27. "Agreed direction" means discussed and accepted in planning, not yet tested
in code. Revisit any of them with evidence from Phase 0.

## Agreed direction

| # | Decision | Why |
| --- | --- | --- |
| 1 | Build it: there is a real gap | No existing tool combines app capture, docs, video, chat, MCP, any agent, any voice, self-hosting and CI updates ([landscape.md](landscape.md)) |
| 2 | Vibe coders are the priority user; engineers get full control underneath | The user's steer; engineers are already served by docs-as-code tools |
| 3 | One walkthrough file per task is the single source of truth | Proven in the first pilot app's tutorial pipeline: one `workflow.json` drove video, captions, guide and checks |
| 4 | Deterministic engine + thin agent skills | Repeatable results; works with weaker agents; any agent with a shell can drive it |
| 5 | Agent-agnostic via Agent Skills (`SKILL.md`) + `AGENTS.md`, CLI, generator MCP server and a built-in agent loop | Claude Code and Codex read skills natively; MCP and the built-in loop cover the rest |
| 6 | Provider adapters for voice, model, search, renderer, hosting; free local defaults | No API key needed for a first run; no lock-in |
| 7 | CI auto-update is core, not an add-on | Keeping docs current is the main reason to use it |
| 8 | Three change tiers: cosmetic auto-publishes; broken and new go to review | Speed without silent meaning changes |
| 9 | Editing three ways (Studio, words, files) on the same files, HyperFrames-style; edits stored as intent | No tool lock-in; edits survive rebuilds |
| 10 | Safe by default: demo data, masking, PII and secret scans, no production writes, human-approved first publish | The first pilot app's training data was a copy of production |
| 11 | Nothing documented that wasn't seen working | Trust; avoids hallucinated features |
| 12 | TypeScript engine, run with `npx` | Playwright, Astro, MCP SDK and the pilot app's original scripts are all Node |
| 13 | Start from the first pilot app's tutorial pipeline (Phase 0) | It already works end to end |
| 14 | Node is the only runtime; no Docker required | Vibe coders don't have Docker; cloud agent sandboxes often can't run it; Playwright pins Chromium and `ffmpeg-static` covers FFmpeg |
| 15 | Capture defaults to the app's preview or live URL plus a test account; demo data goes in through the app's own screens or API | Most target apps are Next.js or Vite + Supabase with preview deploys; no database access or seed scripts needed |
| 16 | Output is a prescaffolded Next.js help app (`help/`): site, chat and MCP as Next.js routes; `aida publish --to <host>` | One project, one deploy; Vercel, AWS Amplify and Netlify support Next.js natively, Cloudflare via OpenNext, any Node server via `next start`; static export for GitHub Pages or S3 (no chat/MCP). Replaces the earlier Starlight + separate function idea |
| 17 | The coding agent does the work with AIDA's skills; the engine (npm) does the repeatable parts in the coding environment or CI; the host only runs `next build` | Matches how vibe coders and engineers already work; no Playwright or FFmpeg on the host |
| 18 | The help app is separate from the user's app by default; `/help` on their domain via a host rewrite or Next.js multi-zones | Never touches their code; works whatever their app is built with. Replaces the earlier "inside the app at /help" default |
| 19 | The Studio is a dev-only `/studio` route in the help app that edits repo files (Keystatic/TinaCMS style); later it can run on a preview deploy behind sign-in, committing to GitHub | Runs where the agent runs; gives a path to a hosted Studio without a separate cloud editor |
| 20 | Token efficiency is a design goal: model tokens only for judgment; three model tiers (fast, standard, deep) per skill; subagents per app area and per walkthrough; small engine outputs; per-run token report and budget | The user's steer (2026-10-22); model tokens are the main running cost and long contexts make weaker agents fumble |
| 21 | AIDA itself is built by an orchestrating agent with subagents on matched models (Haiku for lookups, Sonnet for building, Opus for design and review), tested against a private pilot app | Same principle applied to the build; see [build-plan.md](build-plan.md) |
| 22 | No model API keys in AIDA's own pipeline: judgment work runs through Claude Code. CI does deterministic work only (affected, capture, screenshot diffs, PR comment); broken or new walkthroughs are flagged with the command to run. Optional: the Claude Code GitHub Action on the user's subscription (`claude setup-token` OAuth token) repairs on request. No dollar budget cap | The user's steer (2026-10-25); keeps the engine keyless and free to run |
| 23 | PR screenshot diffs are committed to an `aida-previews` orphan branch in the app repo and shown inline in one PR comment; Actions artifacts as fallback. No preview deploys for now | Needs only the workflow's own GitHub token; no extra service or key |
| 24 | Docs PRs from AIDA request review from the app PR's author (configurable); drafted walkthroughs get the `docs:new` label | The author knows what changed |
| 25 | AIDA is a public repo; GitHub owner and repo are per-user settings, never hardcoded. Help chat is off until an owner adds their own key | Open-source engine; the chat can't run through Claude Code |
| 26 | The help library follows scope.md's categories; walkthroughs set an optional `section:` and their pages live at nested URLs (`/how-do-i/payments/record-a-payment`); old flat `/<id>` links redirect. Brand comes from the app's own CSS/assets into generated theme files that the site, Studio, video and PDFs all read | Hierarchy readers can browse; one brand source for every output (scope.md principle 11) |
| 27 | Capture safety checks the app's database, not only its web address: every env file from the app to the repo root, the process environment and `app.database.url`, found by name and by value. A non-local or unreadable database setting is refused unless `app.database.throwaway` names that exact database (`user@host` on shared hosts such as Supabase poolers) (`host/dbname` when a host serves several) or `app.database.ignoreEnv` names the exact setting the capture server doesn't use, bound to its value (`file:VAR#fingerprint`); neither carries over to another database or a changed value. A live payment key is refused unless `app.allowLivePayments` names it by fingerprint | First outside run: an app on `localhost` was writing to its live Neon `main`; the URL check let it through |
| 28 | Walkthroughs declare the data they need and change (`needs`, `leaves`, `clears`); named states have `setup`/`check` hooks so a walkthrough can be captured on its own and twice; the engine derives and enforces capture order | The capture order lived only in the orchestrator's head; re-runs and partial runs broke on missing data |
| 29 | Until the engine is published to npm under a package name of its own (`aida-docs`, decision 31), the help app depends on a packed engine tarball, never a bare registry name | `"aida": "*"` resolved to an unrelated npm package: a supply-chain risk |
| 30 | Capture failures are classified as walkthrough, app or environment problems; a suspected app bug is reported to a person and never worked around in the walkthrough | Captures found a real app bug (save works, screen doesn't change) that looked like a broken walkthrough |
| 31 | The name is AIDA (Agent-driven Instruction and Documentation Automation): CLI command `aida`, npm package `aida-docs` (the `aida` name on npm is an unrelated package; renamed 2026-10-27, before anything was published), config `aida.config.ts`, env `AIDA_*`, skills `aida` and `aida-*`. Clean break: no compatibility shims for the old working name. The public repo names no pilot app | Agreed 2026-10-26, before going public; nothing had been published under the old name, so there was nobody to migrate |
| 32 | The "Show me" recorder ships now as `aida record`, ahead of Phase 4: a local browser window on capture's own runner (same safety gate, sign-in, `needs` setup, viewport). It writes a draft walkthrough only; targets are checked with capture's `locate()` while the element is on screen; typed values follow the demo-data rules; the draft is replayed once. The hosted Studio recorder stays in Phase 4 and reuses the same event-to-step code | The user's steer (2026-10-27). Flows an agent can't work out from `inspect` needed a person; reusing the runner keeps the recording and the replay on the same footing |

## Open

| Decision | Options | Recommendation |
| --- | --- | --- |
| Business model | Open-source engine plus paid cloud; done-for-you service; internal tool first | Open-source engine now, done-for-you service for early clients, paid cloud once Phase 2 holds up |
| First target user | Vibe coders in Cursor or Claude Code (agent door first); Lovable and Bolt users (GitHub App first) | Agent door first |
| Walkthrough format | YAML with a schema; Markdown with step notes (Doc Detective style); JSON (Argo style, or the first pilot's `workflow.json`) | YAML with a schema, after comparing Argo, Doc Detective and the first pilot's `workflow.json` |
| Docs layer in the Next.js help app | Fumadocs; Nextra; custom | Fumadocs (built for the App Router); check print support in Phase 1 |
| Licence | Apache-2.0; MIT; source-available | Apache-2.0 |
| Second app to test on | Another app in the workspace; a friendly client's app | One with a different stack from the first pilot app |
| Video timeline in the Studio | Own build; embed/extend HyperFrames Studio; export-only | Export-only in Phase 1; test embedding before Phase 2 |
| Video renderer | AIDA's own HTML player (ported from the pilot) + FFmpeg; HyperFrames | Keep that player for Phase 0; decide with the timeline question |
