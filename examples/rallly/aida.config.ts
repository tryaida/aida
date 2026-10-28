// Written by `aida init`; safe to edit by hand afterwards. Every field:
// https://github.com/tryaida/aida/blob/main/packages/engine/src/config/types.ts
// What each one does: https://github.com/tryaida/aida/blob/main/docs/scope.md
// ("The help app", "Swappable providers").
// Detected: Next.js App Router (../apps/web/src/app)
// Routes seen: /[locale], /api
import { defineConfig } from "aida-docs";

export default defineConfig({
  app: {
    // Capture against a production build of the app (`next build && next start`), not
    // `next dev`: the dev server's cache grows to gigabytes over a capture run, and production
    // pages are what readers see.
    baseUrl: "http://localhost:3210",
    // The app's own folder: capture reads its database setting from here and refuses a live one.
    dir: "../apps/web",
  },
  // better-auth database sessions: inserts a session row and sets the signed cookie.
  signIn: "./adapters/sign-in.mjs",
  database: "./adapters/database.mjs",
  // Who readers are, by the role ids walkthroughs sign in as.
  roles: { organizer: "an organizer" },
  walkthroughsDir: "./walkthroughs",
  // This config lives inside the help app itself, so generated output goes
  // right here rather than into a nested `help/` folder.
  outDir: ".",
  buildDir: "./.build",
  // This help app is its own target: the index stage mirrors built pages into
  // its own content/docs + public/ so the help site actually shows them.
  helpApp: ".",
  // Detected from the app by `aida init`; `aida theme` turns it into the help app's
  // app/brand.css, lib/brand.json and public/brand/. Paths are relative to this file.
  brand: {
    name: "Rallly",
    // Set by hand: the brand read from the running app picked a "Home" nav link as the logo.
    logo: "../apps/web/public/static/logo.svg",
    logoDark: "../apps/web/public/static/logo-dark.svg",
    icon: "../apps/web/public/images/logo-mark.svg",
  },
});
