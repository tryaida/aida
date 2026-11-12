// Where `aida demo` finds its sample app and walkthroughs, and what it writes into the demo folder.
// They ship in the package's `assets/` folder, which sits at the package root both in a clone
// (packages/engine/assets, run with tsx) and in the published package (beside dist/), so the same
// path works from source and from the built CLI.
import { join } from "node:path";
import { ENGINE_ROOT } from "../package-root.js";
import { extractBrand, rebaseBrandPaths } from "../init/brand.js";
import { formatBrandBlock } from "../init/write-config.js";
import { listFiles, type DemoFileEntry } from "./folder.js";

export const DEMO_ASSETS_DIR = join(ENGINE_ROOT, "assets", "demo-app");
/** The sample app (Acme Repairs), copied to the demo folder's root. */
export const DEMO_APP_DIR = join(DEMO_ASSETS_DIR, "app");
/** Its walkthroughs, copied to `<demo>/help/walkthroughs`. */
export const DEMO_WALKTHROUGHS_DIR = join(DEMO_ASSETS_DIR, "walkthroughs");

/** The help app inside the demo folder, as `aida init` lays it out. */
export const HELP_DIR_NAME = "help";
/** The sample app's port when nothing else is asked for (also its own default, server.mjs). */
export const DEMO_APP_DEFAULT_PORT = 4310;
/** Read by the demo's aida.config.ts: the sample app's address when `aida demo` started it on
 * another port. */
export const DEMO_APP_URL_ENV = "ACME_REPAIRS_URL";
/** The walkthrough whose outputs the demo points at first: it changes data, needs another
 * walkthrough's data, and has a dialog, a highlight on every step and a status change. */
export const SHOWCASE_WALKTHROUGH = "mark-a-repair-ready";

/** The demo's aida.config.ts: the sample app's address and the brand read from its files. */
export function demoConfigSource(demoDir: string): string {
  const helpDir = join(demoDir, HELP_DIR_NAME);
  const brand = formatBrandBlock(rebaseBrandPaths(extractBrand(demoDir), demoDir, helpDir));
  return `// The config for the aida demo: Acme Repairs, the small fictional app in the folder above
// (server.mjs; no database, no sign-in, data kept in memory). Written by \`aida demo\`, which
// leaves it alone once you've edited it. Every field:
// https://github.com/tryaida/aida/blob/main/packages/engine/src/config/types.ts
import { defineConfig } from "aida-docs";

export default defineConfig({
  app: {
    // Where the sample app runs. \`aida demo\` starts it and sets ${DEMO_APP_URL_ENV} when it
    // uses another port; to run it yourself: node server.mjs (in the folder above).
    baseUrl: process.env.${DEMO_APP_URL_ENV} ?? "http://127.0.0.1:${DEMO_APP_DEFAULT_PORT}",
    // The app's own folder: capture reads its database setting from here (it has none).
    dir: "..",
  },
  walkthroughsDir: "./walkthroughs",
  // Generated pages, PDFs and videos go into this help app itself.
  outDir: ".",
  buildDir: "./.build",
  helpApp: ".",
  // Read from the sample app's styles, manifest and logo files, the way \`aida init\` reads them.
${brand}});
`;
}

/**
 * The demo's files that run: the sample app's server, modules, package.json and public files
 * (app.js runs in the capture browser), and the config the build loads. The demo checks each one
 * is still the copy it wrote before running anything. Its stylesheet isn't code, and changing it
 * is how a person sees the brand follow the app, so it's left out.
 */
export function demoCodeFiles(): string[] {
  return [...listFiles(DEMO_APP_DIR).filter((rel) => !rel.endsWith(".css")), `${HELP_DIR_NAME}/aida.config.ts`];
}

/** Everything the demo copies into its folder, in order: the sample app, its walkthroughs and the config. */
export function demoFileEntries(demoDir: string): DemoFileEntry[] {
  return [
    ...listFiles(DEMO_APP_DIR).map((rel) => ({ rel, src: join(DEMO_APP_DIR, ...rel.split("/")) })),
    ...listFiles(DEMO_WALKTHROUGHS_DIR)
      .filter((rel) => /\.ya?ml$/i.test(rel))
      .map((rel) => ({ rel: `${HELP_DIR_NAME}/walkthroughs/${rel}`, src: join(DEMO_WALKTHROUGHS_DIR, ...rel.split("/")) })),
  ];
}
