# Contributing

Thanks for helping. AIDA is pre-release, so the most useful thing you can do is try it on your
own app and tell us where it broke.

## Reporting a problem

[Open an issue](https://github.com/tryaida/aida/issues/new) with:

- what you ran (the command, or what you asked your coding agent)
- what happened and what you expected
- your app's stack: framework, sign-in library, database
- the output of `aida doctor --config help/aida.config.ts`
- for a failed capture, the `failure.json` it points to (check it for anything private first)

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Changing the code

```bash
git clone https://github.com/tryaida/aida.git && cd aida
npm install && npm run build
npx playwright install chromium   # ffmpeg must be on your PATH too

npm run typecheck
npm test               # fast suite, about five minutes
npm run test:slow      # adds real rendering and Kokoro voice
node skills/check.mjs  # validates the agent skills
```

Read [AGENTS.md](AGENTS.md) first. It lists the ground rules (Node only, walkthrough files as the
single source of truth, safe by default) and the docs to read before changing things:
[docs/scope.md](docs/scope.md), [docs/decisions.md](docs/decisions.md) and
[docs/build-plan.md](docs/build-plan.md).

A few rules worth repeating:

- Keep the repo app-neutral. Use fictional names (`example.com`, "Acme") in code, tests,
  fixtures and docs, never a real app or client.
- Never capture against production data or real logins. Test against a local app with a
  throwaway database.
- Put logic in the engine (`packages/engine`) and keep the help app (`packages/help-app`) thin.
- Add a test for every bug you fix, and check it fails without the fix.
- Use the reader-facing words: walkthrough, help site, help chat, agent connector, Studio.

Pull requests run typecheck, the fast suite and the skills check. Keep each one to one change and
say what it fixes or adds.

By contributing you agree your work is licensed under the [Apache License 2.0](LICENSE).
