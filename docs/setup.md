# Setting up AIDA

The full reference behind the [README](../README.md) quick start: what `aida init` does, every
command, how walkthroughs that change data are ordered, the safety defaults, and the agent skills.
Keeping docs current from CI has its own page: [ci.md](ci.md).

`aida` is the command of the npm package `aida-docs` (the `aida` name on npm is an unrelated
package). Run it either way:

- **From the package:** `npx aida-docs <command>`, or install it (`npm install -g aida-docs`)
  and run `aida <command>`. The package carries the help-app template and the agent skills, so it
  needs no clone. It isn't on npm until the first release (see [Releasing](#releasing)); until
  then, install a tarball from `npm pack` the same way.
- **From a clone:** `node <aida>/packages/engine/dist/cli.js` after `npm run build`, or
  `npx tsx <aida>/packages/engine/src/cli.ts` without a build. A clone uses its own
  `packages/help-app` and `skills/`, so edits there show up in the next `aida init` and
  `aida skills install`.

Most commands take `--json` for short, machine-readable output.

## Set up an app

```bash
aida init <app-dir>                        # scaffold <app-dir>/help and install it
```

`init` copies the help app into `<app-dir>/help`, reads the app's routes and brand, writes
`help/aida.config.ts`, and then:

- **Installs the help app.** The help app never depends on the engine by registry name (the `aida`
  name on npm belongs to an unrelated package, and a pinned tarball keeps hosts on exactly the
  engine you ran). `init` builds the engine if it's running from a clone, packs its runtime part
  into `help/vendor/aida-docs-<version>-<hash>.tgz` (staged in `help/node_modules/.cache`, so it
  works from a read-only install too), points the help app's `aida-docs` dependency at that file
  (dropping an `aida` dependency left from before the rename), and runs `npm install` in `help/`.
  The tarball installs as a real copy, so Turbopack and hosts that only run `npm install && next
  build` both work. It is the help app's runtime part only: no Playwright, Kokoro, ffmpeg or
  pdf-lib and no `aida` command, so hosts install about half as much. Run the CLI from the
  `aida-docs` package or a clone and point it at the help app's config (`--config
  help/aida.config.ts`); the config's `import ... from "aida-docs"` always loads the AIDA you're
  running, never an `aida-docs` in `node_modules` (an import of the old name `aida` is refused).
  Commit `help/vendor/` with the help app (CI installs `help/` from its lockfile and refuses a
  registry `aida-docs` or `aida`). Run `init` again after updating AIDA: it replaces the tarball
  and the dependency and leaves your other edits alone. `--no-install` skips the install (then run
  `npm install` in `help/` yourself).
- **Keeps your app's build clean.** It adds `help` to the app's `tsconfig.json` `exclude`, so
  the app's own `next build` doesn't typecheck the help app. Comments and formatting are kept;
  a new `exclude` carries over what the app already excluded (its `extends` base's, or
  TypeScript's defaults).
- **Signs in for capture (Auth.js).** If the app uses Auth.js (`next-auth` or `@auth/*`), `init`
  writes `help/adapters/sign-in.mjs` and sets `signIn` in the config. It signs each walkthrough's
  persona in by minting the session cookie with the app's own installed Auth.js and its
  secret (v5: `AUTH_SECRET`, then `NEXTAUTH_SECRET`; v4: `NEXTAUTH_SECRET`), read from the
  capture run's environment or the app's `.env.local` and `.env`, never `.env.production*`. If
  the secret is only in a production file, set it in the environment of the capture run (the same
  secret the app server under capture uses). After setting the cookie it checks
  `/api/auth/session` and fails loudly unless the app sees the persona signed in. It only works
  with JWT sessions, only signs in to an app on localhost, and its `claims(persona)` function must
  match the app's own `jwt` callback. The notes at the top of the file explain database sessions
  and seeded users.
- **Checks the app's database.** It warns if the app's database setting points at a live
  database; capture refuses to run against one (see [Safety defaults](#safety-defaults)).

Then:

1. **Check the machine and the app:** `aida doctor --config help/aida.config.ts` checks Node,
   ffmpeg, Playwright's Chromium and its libraries, disk, the app's address and database, email
   and payment settings, the dev-server cache and the help app install, and prints the fix for
   each problem.
2. **Capture against a production build of the app**, not the dev server: `next build && next
   start` in the app. The dev server's cache grows to gigabytes over a capture run.
3. **Open the help site and the Studio:** `npm run dev` in `help/` (add `-- -p 3001` if the app is
   on 3000), then `/studio`. The dev server listens on 127.0.0.1 only, so other machines on the
   network can't reach it.
4. **Through a tunnel or proxy?** Point the tunnel at `http://127.0.0.1:<port>`. The Studio then
   needs a host you list and its access key. Run `aida init <app-dir> --tunnel-host <host>`
   (repeatable): it adds the host to `AIDA_STUDIO_ALLOWED_HOSTS` and a random
   `AIDA_STUDIO_KEY` to `help/.env.local` (git-ignored and owner-only; an existing key is kept),
   and prints private links, `https://<host>/studio/access#key=<key>` and the same on
   `http://localhost:<port>`. The key sits after `#`, so it never reaches the dev server or its
   log. Restart the dev server and open a link once per browser: it sets an httpOnly cookie for
   the Studio (12 hours), and without it every Studio page or API request gets a plain 403,
   **on localhost too**: a tunnel reaches the dev server from this machine, so only the key tells
   the two apart. With no key set, the Studio refuses every host but localhost.
   **Keep the link private: anyone who has it can edit the help app's files, including code the
   dev server runs.** To revoke it, delete the `AIDA_STUDIO_KEY` line, re-run init with
   `--tunnel-host` and restart. A host behind your own sign-in (Cloudflare Access, Tailscale,
   ngrok with OAuth) is safer still. Opened with the key on a host that isn't listed, the
   Studio says so and shows the line to add.
5. **Make the docs:** ask your coding agent ([Agent skills](#agent-skills)), or by hand:

```bash
aida digest --app-repo <app-dir>           # compact map of routes, roles and labels
aida domain --config <cfg>                 # entities, links and states from the database schema
aida brief init --config <cfg>             # app-brief.md skeleton; fill it, then aida brief check
aida outline list --config <cfg>          # the planned walkthroughs, and where the screen differs
aida inspect /some/page --config <cfg>     # what's on screen: exact names, roles, options
aida inspect --config <cfg> --walkthrough <id> --after <step>   # the page after a save
aida inspect --config <cfg> --walkthrough <id> --after <pathId>/<step>   # ...after a path's step
aida record <id> --config <cfg> --page /some/page   # click through once; get a draft walkthrough
aida validate <walkthroughs-dir> --config <cfg>
aida order --config <cfg>                  # capture order the walkthroughs' data implies
aida build --config <cfg> --draft          # capture, voice, render, pages, PDFs, index, checks
aida publish --to static --dry-run         # see what would deploy
```


## Commands

| Command | Does |
| --- | --- |
| `init` | Scaffold and install the help app into `<dir>/help` (engine tarball in `help/vendor/`), with brand colours (light and dark), fonts and logos read from the app; an Auth.js sign-in adapter when the app uses Auth.js; `--tunnel-host` for the Studio, `--no-install` |
| `theme` | Rewrite the help app's theme from the config's `brand`; `--detect` prints a fresh brand block from the app repo; `--from-app` reads the running app signed in and read-only (`--page`, `--as`): button and nav colours, loaded fonts, radius, shadow, density, the logo as drawn and an icon, saved to `brand/from-app.json` beside the config and merged under `brand` (values you set win; `init` does this too when the app answers). `brand.style` (`minimal`, `friendly`, `bold`; default from the app's corners and shadows) or `brand.md`'s `style:` sets the look of videos, covers and screenshot frames |
| `proof` | One proof sheet of the brand on every output (video intro and step frames, help site page, printed page, card) in `<buildDir>/proof/`, also in the Studio's **Proof sheet**; approve it at checkpoint 1 |
| `doctor` | Check the machine and the app before capturing; one fix per problem |
| `digest` | Compact map of an app's routes, roles and on-screen labels (monorepos via `--app`, detail via `--area`) |
| `domain` | The app's domain model read from its schema (Drizzle, else Prisma, else SQL migrations; never a database connection): one line per entity with key columns, states and links; `--entity` for one in full, `--source` to pick a schema |
| `brief` | The app brief, `app-brief.md` beside the config (config `brief` moves it): `sources` lists the app's own docs worth reading (paths and headings only), `init` writes the skeleton from the schema, `check` validates sections, glossary and personal data, `show [--section]` prints it. Once it passes `check` with no personal data or prompts left, `build` passes its opening sections to the help chat, an overview to the agent connector's `get_app_overview`, and its first paragraph to the home page |
| `outline` | Outline cards in `outline.yaml` (`add`, `import`, `list`, `note`, `check`, `status`); capture records where the screen differs from a card |
| `inspect` | Open one page signed in and list its interactive elements, read-only (`--click` repeatable); `--walkthrough <id> --after <step>` replays the steps (writes, like capture) and maps the page they leave; `--after <pathId>/<stepId>` replays a path from its own start page through its opening steps (or on to a shared main step after it joins), with the same safety checks |
| `record` | "Show me": open the app in a browser window, signed in (`--as`), with `--needs` states set up, and turn one click-through into a draft walkthrough. A toolbar adds **Point at**, **Check shown**, **Note** (the step's narration), **New step**, **Undo** and **Finish**. Targets use on-screen names and are checked against the page as they're recorded; typed emails, phone numbers and card numbers become safe demo values; passwords are never kept. Same safety checks as capture; the draft is replayed once afterwards (`--no-replay` skips it, since a replay saves the same things again) |
| `validate`, `import playwright` | Check walkthrough files, their states, caption and chapter line lengths, and every `{{placeholder}}` in reader-facing text (titles, `say`, `caption`, `page_text`, callout labels, cards, a path's `title`/`when`/`note`) has a value in `data`; convert existing Playwright tests into draft walkthroughs |
| `order` | Print the capture order the walkthroughs' `needs`/`leaves`/`clears` imply, and where the database is reset |
| `capture` | Replay walkthroughs in a browser against the app, in that order (`--with-deps` pulls in the walkthroughs they need); screenshots, checks, a failure report saying whether it looks like the walkthrough, the app or the setup. A walkthrough's other `paths` are each captured after a database reset, before the main steps (`capture/paths/<id>/`; without an allowed reset they're marked not captured); a path that saves differently from the main steps is warned about and recorded as `pathDiffs` |
| `paths` | Other screens a walkthrough's task can start from: pages whose code makes the same save as its captured main path (API route, tRPC call or server action), not yet covered by its `paths`. Follows everything a page renders: layouts and templates up the App Router tree, route groups, `@slot` pages on their parent route, intercepting routes over the page the reader came from, barrel re-exports by name and tsconfig/jsconfig path aliases; a hit found through a layout names it in `via` |
| `voice`, `render` | Narrate, then render video per scene (only changed scenes re-render). Each passing path also gets a short narrated clip, `<id>.path-<pathId>.mp4` with `.srt`/`.vtt`, beside the main video: a title card, the path's opening steps (their own `say`), then "Then continue from step N: <title>"; same brand, style and blur (blurred screens are unioned across the main run and every path) |
| `pages`, `pdf` | Help pages with numbered screenshots; PDFs and quick reference cards (a QR code to each guide when `publish.siteUrl` is set) |
| `qa` | Loudness, black frames, caption timing, personal-data and secret scans |
| `build` | All of the above in order, skipping unchanged work (`--with-deps` too); `report.json` names each failed check and its files |
| `affected` | Map a git diff to the walkthroughs it touches (screens their paths visit too); unknown changes mean all |
| `ci` | PR check: affected walkthroughs and the ones they need, capture, screenshot diff, one PR comment tiered cosmetic/broken/new plus possible app bugs (no model, no API keys); `--publish` republishes on merge |
| `version freeze`, `version list`, `whats-new` | Freeze a docs version per release; write the What's new page from merged PRs |
| `edit`, `undo`, `catch-up` | The same edits the Studio makes (steps, data, callouts, blur, paths), with history marked person or agent, and locks |
| `publish` | Deploy to `vercel`, `netlify`, `amplify`, `cloudflare`, `node` or `static`; first production publish needs a person's OK |
| `suggest` | Group unanswered chat questions into suggested new walkthroughs |
| `usage` | Log and report model tokens and cost per stage; budget cap per run |
| `skills install` | Copy AIDA's skills and subagent definitions into a repo |

## Walkthroughs that change data

Most tasks save something, so walkthroughs depend on each other. Each one says so:
`needs: [session-full]`, `leaves: [alex-on-waitlist]`, `clears: [alex-in-morning]`, plus
unrecorded `setup:` steps for data only it uses. Config `states` gives a state `setup`/`check`
hooks that put starting data in through the app's own API (`ctx.request`), so a walkthrough can be
captured on its own and twice; `{{run.id}}` names records setup creates. The engine derives the
capture order, never resets the database inside a chain, and blocks a walkthrough no order works
for; `aida order` prints the plan.

Several ways to do one task: a walkthrough may list `paths`, each with its own start page and
opening steps, joining the main steps at a named step (`joins`) and sharing the rest. Pages add
"Other ways to do this" with when to use each and each path's clip, with a link to the main
video's step it continues from (PDFs print the path's screenshots, and a QR code to the page when
`publish.siteUrl` is set); procedures, the help chat and the agent connector know every path.
`aida paths <id>` finds screens not covered yet.

Text a reader sees or hears (page, PDF, card, video captions and cards, narration, search) fills
in `{{data}}` placeholders from the walkthrough's `data`; `{{run.id}}` is never printed.

One persona: `start.signed_in_as` and `start.persona.role` must agree. Config `roles` gives each
role its reader-facing name (`roles: { admin: "an organiser" }`).

## Safety defaults

- **The app's database.** Capture, build, CI and `inspect --after` refuse to run unless every
  database setting the app may start with is on this machine: every env file from the app's
  directory to the git root, the process environment and `app.database.url`, found by name and
  by value. Use a Neon or Supabase branch or a local Postgres. `app.database.throwaway` names an
  exact disposable database (`host`, `host/database`, `user@host` on shared hosts such as
  Supabase poolers, or the `#fingerprint` the refusal prints); `app.database.ignoreEnv` lists
  `file:VARIABLE#fingerprint` (or `file:VARIABLE@host`) settings a capture server started with
  `app.database.url` doesn't use, bound to the database each points at now. Neither carries over
  to another database. Secrets injected at run time (Doppler, Infisical, op://) refuse until
  acknowledged the same way.
- **Email, texts and payments.** A real email or SMS sender is a warning until `app.outbound:
  "dry-run"` confirms the app sends nothing during capture. A live Stripe key refuses unless
  `app.allowLivePayments` names that exact setting and key (`file:VARIABLE#fingerprint`).
- **The app's address.** Write steps run only against a local app unless `allowWrites` is set.
- Personal details are blurred in screenshots before capture, and every output is scanned for
  personal data and secrets before it publishes.
- Demo data uses example.com and reserved fictional phone ranges.
- Agents can't approve the first production publish; a person has to.

## Agent skills

`skills/` holds the Agent Skills that drive AIDA from a coding agent. `aida` is the entry point
("make help docs for my app"); it hands off to `aida-discover`, `aida-understand`, `aida-plan`,
`aida-write`, `aida-repair`, `aida-review` and `aida-demo-data`. Each names a model tier, and
Claude Code subagent definitions in `skills/agents/` match them: Haiku for discover, Sonnet for
write, repair and review, Opus for understand and plan. Shared style, safety, token and walkthrough-format references live in
`skills/references/`.

Install into a target repo with `aida skills install --target <repo>` (copies skills into
`.claude/skills/` and agents into `.claude/agents/`, never overwriting changed files). Codex and
other AGENTS.md-reading agents can point at `skills/AGENTS.md`. Validate with
`node skills/check.mjs`.

## Repo layout

| Path | What |
| --- | --- |
| `packages/engine` | The `aida-docs` npm package (its command is `aida`): CLI and every pipeline stage. Packing bundles the help-app template, the skills and LICENSE into it |
| `packages/help-app` | The Next.js help app template (site, chat, agent connector, Studio) |
| `skills/` | Agent skills, subagent definitions and references |
| `docs/` | Scope, decisions, build plan and history |

## Releasing

The engine is published from `packages/engine` as `aida-docs`. `npm pack` and `npm publish` run
`scripts/prepack.mjs` first: a clean build without source maps, then copies of
`packages/help-app` (as `templates/help-app`, only files git tracks), the root `skills/` and
`LICENSE` into the package. `scripts/postpack.mjs` removes the copies again (they're git-ignored
meanwhile). Pack from a clean, committed tree.

1. **Bump the version** in `packages/engine/package.json` (0.x: a breaking change bumps the
   minor), then run `npm install` at the repo root so `package-lock.json` matches.
2. **Check:** `npm install && npm run typecheck && npm test && node skills/check.mjs`.
3. **Look at what ships:** `cd packages/engine && npm pack --dry-run`. Expect `dist/` (`.js` and
   `.d.ts`, no `.map`), `schema/`, `assets/`, `src/init/templates/`, `templates/help-app/`,
   `skills/`, `README.md`, `LICENSE` and `package.json`, and nothing else: no `node_modules`,
   `.env*`, `*.tsbuildinfo` or `.next`. For a real try, `npm pack --pack-destination ~`, install
   the tarball in an empty folder and run its `aida init` on a scratch Next.js app.
4. **Publish:** `cd packages/engine && npm publish --access public` (needs an npm login with
   rights to `aida-docs`). Then tag the commit, e.g. `git tag aida-docs-v0.1.0 && git push --tags`.

Later: publish from GitHub Actions with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no npm token in the
repo, and a provenance statement on the package), triggered by a version tag.
