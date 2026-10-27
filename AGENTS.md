# AGENTS.md

Guidance for coding agents (Claude Code, Codex, others) working in this repo.

## What this is

AIDA (Agent-driven Instruction and Documentation Automation) generates and maintains user-facing
help for web apps: doc site with printable pages, narrated videos, help chat, and an MCP server,
kept current from CI. Phase 0 and most of Phase 1 are built; progress and milestones are in
`docs/build-plan.md`. Setup and command reference: `docs/setup.md`.

## Read before working

1. `docs/scope.md` — the plan. Treat it as the spec.
2. `docs/decisions.md` — agreed direction and open decisions. Don't re-decide agreed items without
   new evidence; for open items, follow the recommendation unless the user says otherwise.
3. `docs/build-plan.md` — milestones, status and log.

Test apps live outside this repo. Capture only against an app's local demo or throwaway database,
never production. Keep this repo app-neutral: don't name specific apps or clients in code, tests,
fixtures or docs; use fictional names (example.com, "Acme").

## Commands

`npm test` (fast, ~5 min), `npm run test:slow` (render + Kokoro), `npm run typecheck`,
`npx tsx packages/engine/src/cli.ts <command> --help`.

## Ground rules

- The engine is deterministic TypeScript run with `npx`; agent skills handle judgment only.
- The output is a prescaffolded Next.js help app (`help/`): site, chat and MCP are Next.js routes;
  the Studio is a dev-only `/studio` route. Keep the app thin and put logic in the engine package.
- Node is the only runtime. Don't add Docker requirements; hosts only run `next build`.
- Walkthrough files are the single source of truth for every output.
- Safe by default: never capture against production data or real logins; fake data uses example.com
  and reserved fictional phone ranges; never copy API keys into the repo.
- User-facing words: "walkthrough", "help site", "help chat", "agent connector", "Studio".
- Keep `docs/scope.md` in sync with the shared doc (https://claude.ai/artifact/JisTyr7bSDj8tK9KXLuMRr)
  when either changes, and add a dated entry to `docs/discussion-log.md` for significant planning
  conversations.
