# Safety rules

From `docs/scope.md` → "Safety and trust" and "Capture modes". Every skill that touches a real
app, writes demo data, or captures a screen follows these without exception.

## Production data

- Never write to a production database or account by default.
- Quick mode (preview/live URL + test account) only *reads* unless a step explicitly needs to
  save — then ask the person first, and recommend a separate demo account or workspace.
- Write steps (`click`, `type` that submits) run only against local or preview environments
  unless a person has explicitly allowed otherwise for that run.

## The app's database (capture refuses, `aida doctor` reports)

An app on `localhost` can still write to a live database, so `capture`, `build`, `ci` and
`inspect --after` check the database itself before the browser opens. They read every
database-looking setting (by variable name and by value) in every env file from the app's
directory (`app.dir`) up to the git root, the process environment and `app.database.url`. Any
setting that isn't on this machine, or that AIDA can't read, refuses the whole run; which file
"wins" doesn't matter. Fixes, safest first:

1. A disposable copy: a Neon branch or Supabase branch made for capture, or a local Postgres, with
   the app started on it.
2. `app.database.throwaway: ["<host>"]` tells AIDA that exact database is a disposable copy it
   may write test records to. `host/database` names one database on the host (required when the
   app uses several there). On a host many customers share (a Supabase pooler, PlanetScale,
   Prisma, Appwrite Cloud) it must be `user@host`; a setting whose `options` routes to another
   project needs `?endpoint=<id>` / `?reference=<ref>` too. `#<fingerprint>` from the refusal
   names any of these without the hostname. Exact names only; anything else is refused again.
3. `app.database.ignoreEnv: [".env:DATABASE_URL#<fingerprint>"]` says the capture server doesn't
   use that setting because it's started with `app.database.url` instead (only honoured with
   `url`). Each entry is bound to the database the setting points at now: `#<fingerprint>` as the
   refusal prints it (use this in a public repo), or `@<host>`. Pointing it elsewhere, or a new
   file or variable, is refused again.
4. Doppler/Infisical config files and `op://` references inject secrets at run time, so AIDA
   can't see the database: it refuses until `app.database.url` is set and the config file or
   setting is acknowledged in `ignoreEnv` (`"doppler.yaml#<fingerprint>"`), confirming the
   capture server isn't started through `doppler run` / `infisical run` / `op run`.

A "local" database can still be a tunnel (cloud-sql-proxy, `pscale connect`, `ssh -L`) to a
hosted one: AIDA says so, and warns on proxy hints in env files and known tunnel ports.

Explain what an opt-in means before suggesting it, and never set one without the person's OK: it
is the person saying "writing test records there is fine".

## Email, texts and payments

- A real email/SMS/chat sender in the app's settings (Resend, Twilio and the like) is a warning:
  capture fills in real forms, so the app may send real messages. `app.outbound: "dry-run"`
  silences it once the person confirms the app sends nothing while captured.
- A live Stripe key (`sk_live_`, `rk_live_`) refuses capture. `"dry-run"` doesn't cover it; only
  `app.allowLivePayments` listing that exact setting and key (`.env.local:STRIPE_SECRET_KEY#<fingerprint>`,
  a one-way fingerprint the refusal prints) does; a different key refuses again. Ask for a test
  key instead.

## Signing in and the Studio

- `init`'s Auth.js sign-in adapter mints a session cookie from the app's own secret, read from
  the run's environment or `.env.local`/`.env`, never `.env.production*`. It works only with JWT
  sessions and an app on localhost, and its `claims(persona)` must match the app's `jwt`
  callback. It fails loudly if the app doesn't see the persona signed in.
- The Studio edits repo files, including code the dev server runs. Off localhost it needs a host
  listed with `aida init --tunnel-host <host>` and the `AIDA_STUDIO_KEY` access link, which
  `init` writes to `help/.env.local`. Never paste that link into a PR, an issue or the docs;
  delete the key line to revoke it.

## Demo data

- Emails: always `@example.com`.
- Phone numbers: use exactly the ranges `aida qa`'s personal-data scan (`qa/pii.ts`) treats as
  fictional — nothing broader:
  - AU mobile: `0491 570 xxx`–`0491 579 xxx`.
  - AU landline: `(0X) 5550 xxxx` / `(0X) 7010 xxxx`, X in {2,3,7,8}.
  - US/Canada: `555-0100`–`555-0199` (any area code).
  - UK: `07700 900000`–`07700 900999` (Ofcom's drama range).
  Never a real-looking number, and never a broad guess like "04xx xxx xxx" — a full AU mobile
  prefix is not reserved for fiction, only the `0491 57x` block above is.
- Names: invented, not pulled from real records, support tickets, or the person's own contacts.
- Demo data goes in through the app's own screens or API. Never write a seed script or touch a
  database directly unless an engineer explicitly asks for one (`aida-demo-data`).

## Masking

- Any field carrying a real person's name, email, phone, or address gets masked (`mask:` on the
  step) before capture, not edited out afterward.
- When in doubt, mask it — a false positive costs nothing; a leaked real name is a privacy breach.

## Secrets

- Test logins and API keys live in CI/host secrets or a local `.env`, never in a walkthrough file,
  a committed `aida.config.ts`, or any generated output.
- Every build runs a secrets scan (`aida qa`) before publish; a found secret blocks publish.

## Truthfulness

- Never write a `page_text`, `say`, or outline card describing something that hasn't been seen
  working in a real capture against the real app. No invented buttons, results, or steps.
- A page can only publish if every step on it passed capture.

## Approval gates

- First publish of any help site is always approved by a person — no skill auto-publishes a first
  run.
- Cosmetic CI updates (screenshots/video refresh, no meaning change) auto-publish. Broken or new
  walkthroughs always go to a person via PR review or the approval channel in use.
