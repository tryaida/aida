// Written by `aida init`; safe to edit by hand afterwards. See
// packages/engine/src/config/types.ts for every field, and docs/scope.md
// ("The help app", "Swappable providers") for what each one does.
import { defineConfig } from "aida";

export default defineConfig({
  app: {
    // TODO: the app this help site documents (its local dev URL or a preview deploy).
    baseUrl: "http://localhost:3000",
  },
  walkthroughsDir: "./walkthroughs",
  // This config lives inside the help app itself, so generated output goes
  // right here rather than into a nested `help/` folder.
  outDir: ".",
  buildDir: "./.build",
  // This help app is its own target: the index stage mirrors built pages into
  // its own content/docs + public/ rather than some separate site.
  helpApp: ".",
});
