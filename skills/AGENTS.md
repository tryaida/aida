# AIDA skills

This repo uses [AIDA](https://github.com/tryaida/aida) to generate and keep its help site, help chat, and
agent connector current from walkthrough files. Point your coding agent at the `aida` skill for
anything help-docs related — "make help docs for my app", "update the help site", "why didn't the
payments page update".

`aida` is the command of the npm package `aida-docs`: run it as `npx aida-docs <command>`, or
install it once (`npm install -g aida-docs`) and run `aida <command>`. Never `npx aida`, which
fetches an unrelated npm package.

Install the skills once with `npx aida-docs skills install --target <repo>`. By default it copies
them into `.claude/skills/` and the subagent definitions into `.claude/agents/` (Claude Code;
Cursor and GitHub Copilot read these too). Add `--agent codex` (or `gemini`, `cursor`, `copilot`,
`opencode`, `other`) to copy the whole tree into `.agents/skills/`, the shared folder Codex,
Gemini CLI and most other agents read.

Read `skills/aida/SKILL.md` first (the `aida` skill, wherever it was installed) — it's the entry point and routes to the rest
(`aida-discover`, `aida-understand`, `aida-interview`, `aida-plan`, `aida-write`, `aida-repair`, `aida-review`,
`aida-demo-data`). Don't read every skill up front; each one is short on purpose and loads its
own reference files only when needed.

Ground rules this project expects any agent to follow, from the AIDA repo's own `AGENTS.md`:
walkthrough files are the single source of truth; never capture against production data or real
logins; demo data uses `example.com` emails and reserved fictional phone ranges; never copy an API
key into the repo; use "walkthrough", "help site", "help chat", "agent connector", and "Studio" in
anything a reader sees.
