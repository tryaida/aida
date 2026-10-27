<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/aida-logo-dark.svg">
    <img alt="AIDA: Agent-driven Instruction and Documentation Automation" src="docs/media/aida-logo.svg" width="460">
  </picture>
</h1>

**Turn your app into user guides and narrated tutorials.**

AIDA (Agent-driven Instruction and Documentation Automation) works with your coding agent to
write step-by-step walkthroughs of your web app, then runs each one in a real browser against
your running app. Every walkthrough becomes a help page with screenshots, a printable guide and a
narrated video, all from the same file. When a pull request changes a screen, CI re-runs the
walkthroughs it touches and tells you which pages changed and which ones broke.


https://github.com/user-attachments/assets/3ea1357c-b653-4ab3-bf58-d1a0f93d4d0c



## What you get

You (or your agent) write one walkthrough file per task. Each step says what to do, what to say,
and what the reader should see:

```yaml
walkthrough: invite-a-teammate
title: Invite a teammate
for: Workspace admins
start:
  signed_in_as: admin
  page: /settings/team
steps:
  - id: open-invite
    title: Open the invite form
    say: Click Invite teammate.
    caption: Click Invite teammate.
    page_text: Click **Invite teammate**.
    actions:
      - do: click
        target: { role: button, name: Invite teammate }
        highlight: true
  # ...enter their email, choose a role, send
```

`aida build` replays it against your app and writes:

| Output | What it is |
| --- | --- |
| **Help page** | A page on a Next.js help site with numbered, highlighted screenshots, search, print styles and a "last checked" date. A page only publishes if every step passed against the real app. |
| **Printable guides** | A PDF per guide, a full manual, and a one-page quick reference card. |
| **Narrated video** | An MP4 per walkthrough with captions (SRT, VTT) and chapters. Narration uses a local voice (Kokoro) by default, so no API key is needed. |
| **Help chat** *(experimental)* | Answers questions from your guides only, with links to the pages it used. Runs on the site or inside your app via a script tag, using your Anthropic key. |
| **Agent connector** *(experimental)* | A read-only MCP server so other agents can search your guides and fetch step-by-step procedures. |

```
help/
  walkthroughs/invite-a-teammate.yaml         the source of truth
  pages/invite-a-teammate/index.mdx           help page
  pages/invite-a-teammate/screenshots/        step-01.png, step-02.png, ...
  videos/invite-a-teammate/                   .mp4, .srt, .vtt, .chapters.vtt
  pdf/                                        invite-a-teammate.pdf, .card.pdf, manual.pdf
```

The help site is an ordinary Next.js app in your repo. Edit text and screenshot callouts in the
local Studio (`npm run dev` in `help/`, then open `/studio`) and deploy it anywhere Next.js runs:
Vercel, Netlify, AWS Amplify, Cloudflare, a Node server or a static host.

## Quick start

AIDA isn't published to npm yet, so run it from a clone. You need Node 22+ and `ffmpeg` on your
PATH, and your app running locally against a throwaway database.

```bash
git clone https://github.com/tryaida/aida.git && cd aida
npm install && npm run build
npx playwright install chromium
alias aida="node $PWD/packages/engine/dist/cli.js"

aida init ~/my-app                                       # adds ~/my-app/help and installs it
aida doctor --config ~/my-app/help/aida.config.ts        # checks the machine and the app, one fix per problem
aida skills install --target ~/my-app                    # adds the agent skills to your repo
```

Then open your coding agent in `~/my-app` and ask:

> Make help docs for my app.

The agent maps your app, proposes a list of guides for you to approve, writes and captures each
walkthrough, and fixes what fails. To see the result, run `npm run dev` in `help/` and open the
site. Run `aida build --config help/aida.config.ts` to rebuild it all yourself.

Capture against a production build of your app (`next build && next start`) rather than the dev
server. [docs/setup.md](docs/setup.md) covers the sign-in adapter, the Studio over a tunnel, and
every command.

## Supported agents

AIDA's engine is a deterministic CLI that never needs a model. Your coding agent does the judgment
work using the skills in [`skills/`](skills): planning what to document, writing walkthroughs,
repairing broken ones and reviewing the output.

| Agent | Support |
| --- | --- |
| **Claude Code** | Main target. `aida skills install` adds the skills and subagents, each on a suggested model tier: Haiku to map the app, Opus to plan, Sonnet to write, repair and review. |
| **Codex** and other agents that read `AGENTS.md` or `SKILL.md` | Point them at [`skills/AGENTS.md`](skills/AGENTS.md). Same skills, run on whichever single model you've chosen. Less tested than Claude Code. |
| **Claude Code GitHub Action** *(optional)* | Repairs a broken walkthrough when someone comments `@claude` on a PR. Uses a Claude Code OAuth token, not an API key. |

## How updates work

`aida init --ci` adds a GitHub workflow. On every pull request it:

1. Maps the diff to the walkthroughs it affects, using routes, API calls, components and imports.
   If it can't tell, it re-runs them all.
2. Re-captures only those walkthroughs, plus any they need data from.
3. Compares the new screenshots with the published ones and posts one PR comment:
   - **Cosmetic:** the screen changed but every step still works. The pages refresh on merge and
     nobody has to do anything.
   - **Broken:** a step no longer works. The comment includes the `aida-repair` command to run in
     your agent.
   - **New:** a route no walkthrough covers yet, with the `aida-write` command to draft one.
   - **Possible app bugs** are listed separately: for example, a save that returned success while
     the screen didn't change. They come with evidence and no repair command, because a person
     needs to look at them.

The base workflow uses no model and no API keys. Details and options are in
[docs/ci.md](docs/ci.md).

## Safe by default

- Capture refuses to run unless every database the app could connect to is on your machine (or
  is a throwaway you've named exactly).
- It warns about real email and SMS senders, and refuses live payment keys.
- Write steps only run against a local app.
- Personal details are blurred in screenshots, and every output is scanned for personal data and
  secrets before it publishes.
- Demo data uses `example.com` addresses and reserved fictional phone numbers.
- An agent can't approve the first production publish. A person has to.

Full details are in [docs/setup.md](docs/setup.md#safety-defaults).

## Status and roadmap

AIDA is pre-release. It has been run end to end on a few real Next.js apps but hasn't had outside
users yet. Expect rough edges and breaking changes.

**Works today**

- Walkthrough files with validation, capture in Playwright, and data dependencies between
  walkthroughs (`needs`, `leaves`, `clears`) with the capture order worked out for you
- Help site (Next.js + Fumadocs) with search, print styles, `llms.txt`, and branding read from
  your app
- PDF guides, a full manual and quick reference cards
- Narrated videos with captions and chapters using the local Kokoro voice
- `aida init`, `doctor`, `digest`, `inspect`, and a sign-in adapter for Auth.js apps
- Studio for editing text, callouts and blur boxes, with history and undo
- Agent skills for Claude Code
- PR checks in GitHub Actions: affected walkthroughs, screenshot diffs, and a tiered PR comment
- Safety checks for databases, outbound email, SMS and payments, and personal data

**Experimental**

- Help chat and agent connector (MCP)
- `aida publish` adapters for Vercel, Netlify, Amplify, Cloudflare, Node and static export. Dry
  runs are tested; most hosts haven't had a real deploy yet.
- CI repair through the Claude Code GitHub Action, and keeping docs in a separate repo
- Versioned docs and an auto-generated "What's new" page
- Importing Playwright tests as draft walkthroughs (about a third of calls map automatically)
- `aida record`: click through a task once in a browser window and get a draft walkthrough. Tested
  on fixture pages; not yet used by a person on a real app
- MiniMax and ElevenLabs voices
- Codex and other `AGENTS.md`-based agents

**Planned**

- An npm release as `aida-docs` (the `aida` name on npm is an unrelated package), so you can run
  `npx aida-docs` without cloning
- Sign-in helpers for Clerk, Supabase Auth and Firebase
- A setup path for no-code builders (Lovable, Bolt) that doesn't require opening GitHub
- Longer-term evidence that docs stay current over weeks of real app changes

The detailed plan is in [docs/scope.md](docs/scope.md), and milestone status is in
[docs/build-plan.md](docs/build-plan.md).

## Contributing

```bash
npm install
npm test               # fast suite, about five minutes
npm run test:slow      # adds real rendering and Kokoro voice
npm run typecheck
node skills/check.mjs  # validates the agent skills
```

Read [AGENTS.md](AGENTS.md) before changing things. It lists the ground rules and the docs to read
first.

Licence: Apache-2.0.
