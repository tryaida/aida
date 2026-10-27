<h1>
  <img alt="AIDA: Agent-driven Instruction and Documentation Automation" src="https://raw.githubusercontent.com/tryaida/aida/main/docs/media/aida-logo.svg" width="460">
</h1>

**Turn your app into user guides and narrated tutorials.**

AIDA works with your coding agent to write step-by-step walkthroughs of your web app, then runs
each one in a real browser against your running app. Every walkthrough becomes a help page with
screenshots, a printable guide and a narrated video, all from the same file. When a pull request
changes a screen, CI re-runs the walkthroughs it touches and tells you which pages changed and
which ones broke.

This is the `aida-docs` package: the `aida` command and the engine behind it. The help site it
adds to your repo is an ordinary Next.js app.

> **Pre-release.** AIDA has been run end to end on a few real Next.js apps but hasn't had outside
> users yet. Expect rough edges and breaking changes between 0.x versions.

## Quick start

You need your app running locally against a throwaway database (capture refuses a live one).

```bash
npx aida-docs init ~/my-app                                   # adds ~/my-app/help and installs it
npx aida-docs doctor --config ~/my-app/help/aida.config.ts    # checks the machine and the app, one fix per problem
npx aida-docs skills install --target ~/my-app                # adds the agent skills to your repo
```

Then open your coding agent in `~/my-app` and ask:

> Make help docs for my app.

The agent maps your app, proposes a list of guides for you to approve, writes and captures each
walkthrough, and fixes what fails. To see the result, run `npm run dev` in `help/` and open the
site. To rebuild everything yourself:

```bash
npx aida-docs build --config ~/my-app/help/aida.config.ts
```

Commit `help/` along with `help/vendor/`: the help app installs its runtime part of the engine
from a tarball there, so a host that runs `npm install && next build` doesn't download Playwright,
the voice model or ffmpeg.

## What you get

| Output | What it is |
| --- | --- |
| **Help page** | A page on a Next.js help site with numbered, highlighted screenshots, search, print styles and a "last checked" date. A page only publishes if every step passed against the real app. |
| **Printable guides** | A PDF per guide, a full manual, and a one-page quick reference card. |
| **Narrated video** | An MP4 per walkthrough with captions (SRT, VTT) and chapters, narrated by a local voice (Kokoro), so no API key is needed. |
| **Help chat** *(experimental)* | Answers questions from your guides only, with links to the pages it used. |
| **Agent connector** *(experimental)* | A read-only MCP server so other agents can search your guides and fetch procedures. |

## Requirements

- Node.js 22 or later
- `ffmpeg` on your PATH (AIDA falls back to a bundled build if it can't find one)
- Playwright's Chromium: `npx playwright install chromium`
- A web app you can run locally. AIDA is built and tested with Next.js apps, and route detection
  is Next.js only for now.

## Docs

Setup, every command, the safety defaults and how CI keeps docs current are on GitHub:

- [README](https://github.com/tryaida/aida#readme)
- [Setup and command reference](https://github.com/tryaida/aida/blob/main/docs/setup.md)
- [Keeping docs current from CI](https://github.com/tryaida/aida/blob/main/docs/ci.md)
- [Issues](https://github.com/tryaida/aida/issues)

Note: the npm package called `aida` is unrelated to this project. AIDA's package is `aida-docs`.

Licence: Apache-2.0.
