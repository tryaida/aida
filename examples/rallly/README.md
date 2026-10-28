# Example: Rallly

[Rallly](https://github.com/lukevella/rallly) is an open-source meeting scheduler (Next.js App
Router, better-auth, Prisma, pnpm workspace). This folder is the AIDA help app's own files from a
run against it: config, adapters, four walkthroughs and the pages they built. Videos and PDFs are
build outputs and aren't committed; rebuild them with `aida build`.

| Walkthrough | For | Steps | What it does |
| --- | --- | --- | --- |
| `create-a-poll` | Organizers | 6 | Names an event, picks all-day dates next month, creates the poll |
| `vote-on-a-poll` | Invitees (signed out) | 5 | Marks dates on an invite link, adds a name, saves |
| `pick-the-final-date` | Organizers | 4 | Finalizes a poll and chooses who gets the calendar invite |
| `add-a-comment` | Invitees (signed out) | 3 | Leaves a comment on a poll |

All four pass capture against a production build with the seeded demo data, and each one that
saves data checks the database afterwards (`validate.database`). `proof.png` is the brand proof
sheet.

## Run it yourself

Needs Node 24 for Rallly (AIDA itself runs on Node 22+), pnpm, a local Postgres and ffmpeg. No
Docker: Redis, S3 and the mail catcher in Rallly's compose file are optional.

```bash
git clone https://github.com/lukevella/rallly.git && cd rallly
pnpm install

# A local database for the demo data (any local Postgres)
createdb rallly_demo
cat > .env <<'EOF'
SECRET_PASSWORD=<openssl rand -hex 32>
NEXT_PUBLIC_BASE_URL=http://localhost:3210
DATABASE_URL=postgres://<user>:<password>@localhost:5432/rallly_demo
SUPPORT_EMAIL=support@example.com
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
NEXT_PUBLIC_SELF_HOSTED=true
EOF
cp .env apps/web/.env.local
grep DATABASE_URL .env > packages/database/.env
pnpm db:generate && pnpm db:deploy && pnpm db:seed

# The seed uses real-looking domains; AIDA's demo data uses example.com
psql rallly_demo -c "update users set email = split_part(email,'@',1)||'@example.com';
  update participants set email = split_part(email,'@',1)||'@example.com' where email is not null;
  update scheduled_event_invites set invitee_email = split_part(invitee_email,'@',1)||'@example.com';
  update poll_invites set email = split_part(email,'@',1)||'@example.com' where email is not null;"

# Snapshot it: the database adapter restores this before each capture that saves data
mkdir -p help/.demo-data && pg_dump -Fc rallly_demo -f help/.demo-data/rallly-demo.dump

# Production build. Rallly builds `output: "standalone"`, so start that server, and bind it to
# `localhost` (on 127.0.0.1 its locale rewrite proxies to localhost and hangs).
cd apps/web && set -a && . ../../.env && set +a && npx next build
cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public/. .next/standalone/apps/web/public/
PORT=3210 HOSTNAME=localhost node .next/standalone/apps/web/server.js &
cd ../..

# AIDA: scaffold the help app, then drop this example's files over it
aida init . --app apps/web --app-url http://localhost:3210
cp -r <aida>/examples/rallly/{aida.config.ts,adapters,walkthroughs,brand} help/
aida doctor --config help/aida.config.ts
aida build --config help/aida.config.ts
cd help && npm run dev -- -p 3001       # the help site, and /studio
```

## What's in here

- `aida.config.ts`: what `aida init` wrote, plus the two adapters and the logo set by hand.
- `adapters/sign-in.mjs`: Rallly signs people in with an emailed code (better-auth), which capture
  can't complete. `aida init` writes this adapter for any better-auth app: it inserts a row in the
  session table for the persona's seeded user, sets the signed `better-auth.session_token` cookie,
  then asks the app who's signed in and fails unless it's that user. It refuses any app or
  database that isn't on this machine. For Rallly four things were edited, as the file's notes
  ask: `SECRET_VARS` (Rallly's secret is `SECRET_PASSWORD`), `SESSION_PATH`
  (`/api/better-auth/get-session`), the snake_case `sessions`/`users` table names, and `USERS`.
- `adapters/database.mjs`: `validate.database` queries, and `reset()` restores the demo snapshot.
- `walkthroughs/`: the four walkthroughs. The two for invitees run signed out on a seeded poll's
  invite link (`/invite/seed-0170`); Rallly signs them in as a guest when they vote.
- `pages/`: the help pages and screenshots `aida build` wrote from them.

## What the run taught us

Fixed in the engine as part of this run:

- `aida init` assumed the app was on port 3000 and read the brand from whatever answered there,
  which was a different app. It now reads the app's address from its env files (`NEXT_PUBLIC_BASE_URL`
  and similar, or `PORT`) and scripts, takes `--app-url`, and only reads a brand from a page that
  names the app.
- `aida domain` found no schema: Rallly's Prisma schema is split across `prisma/models/*.prisma`
  in a workspace package. It now reads the whole schema folder and falls back to the workspace root
  when the app's own folder has none (the same for `aida brief init`).
- `aida build` ran out of memory on a 4-core, 8 GB machine: two walkthroughs rendered at once,
  each with one Chromium page and ffmpeg encode per CPU. Render workers now also fit the free
  memory and are shared between the walkthroughs rendering at once.
- Capture and `inspect` defaulted to an Australian locale and time zone. They now default to
  `en-US` and `UTC`; set `locale` and `timezone` in the config for your readers.
- The config `aida init` writes no longer carries this machine's absolute paths.

Fixed in a second pass:

- `aida init` writes a better-auth sign-in adapter (database sessions, Postgres) as well as the
  Auth.js one. The adapter here is that template with Rallly's names filled in.
- `aida inspect --as <role>` needed a walkthrough with that role already, so the first one had
  to be written blind. It now also takes a role the config names (`roles`, `readers`).
- `inspect` stopped at 80 lines with no way to see the rest; the Rallly calendar alone is 40
  buttons. `--skip <n>` shows the next window (the cut-off line says which), `--lines 0` all.
- `theme --from-app` picked a "Home" menu item, dimmed behind a dialog's overlay, as the logo.
  It now skips graphics under an overlay and icons beside menu words like "Home". Rallly's app
  shows no logo when signed in, so the logo here is still set from `public/static/logo.svg`.
- With a wordmark logo the help site header showed the name twice ("RALLLY Rallly"). A logo
  much wider than tall now shows on its own (`logoWide` in `lib/brand.json`).

- The walkthroughs here have no `intro:`/`outro:`. The videos sent empty text to the voice, which
  played a short burst of noise on otherwise silent cards, and the outro card was blank. Empty
  lines are no longer voiced; a missing intro now narrates the title and summary, and a missing
  outro says it's done and recaps the chapters (or the first step titles).
- Steps without a `chapter:` started a blank chapter on the video's intro card instead of
  continuing the one before, and the video cards and printed covers repeated the name beside a
  wordmark logo.

Worth knowing when writing walkthroughs for an app like this: new invitees land on a poll with
their own row already open, and finalizing opens a chain of dialogs. Both were found from failure
screenshots, which made each fix one edit.
