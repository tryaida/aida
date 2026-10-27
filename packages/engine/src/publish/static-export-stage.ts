// `aida publish --to static`'s staged export build. Next's static export (`output: "export"`)
// flatly can't serve a dynamic route handler at all — not just chat/MCP's POST/DELETE handlers
// (app/api/chat, app/api/mcp), but every Studio API route too (app/studio/api/**, all dev-only
// per app/studio/_lib/dev-only.ts): Next's build-time "collect page data" step still visits every
// route handler under app/ regardless of request-time guards like `isDev()`, and fails the whole
// build the moment one lacks `dynamic = "force-static"` — and GET-only `force-static` wouldn't
// even help app/api/chat or app/api/mcp, since static export doesn't run a server to answer their
// POST/DELETE methods at all (docs/scope.md host table: "Site and search; no chat or MCP").
//
// So rather than mutate the user's `app/api` and `app/studio` (even briefly — a crash mid-build
// would leave their repo broken), this builds from a throwaway staged copy of the whole help
// app with those two trees removed, and copies the result's `out/` back to the real `helpRoot`.
// `node_modules` is symlinked rather than copied into the stage — it's the same already-resolved
// install, not a second `npm install`, so this doesn't reintroduce the symlinked-node_modules /
// zod-mismatch problem a plain `cp -r` or `npm link` of the *package itself* caused earlier.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Directories never copied into the stage: build output, the staged copy's own previous run,
 * VCS metadata, and `node_modules` (symlinked instead — see module doc comment). */
const SKIP_ENTRIES = new Set(["node_modules", ".next", "out", ".git", ".aida"]);

export function staticExportStageDirFor(helpRoot: string): string {
  return join(helpRoot, ".aida", "static-export-stage");
}

/**
 * Builds `<helpRoot>/.aida/static-export-stage`: a copy of `helpRoot` with `app/api` and
 * `app/studio` removed, `node_modules` symlinked, and everything else copied as-is. Overwrites
 * any previous stage. Returns the stage's absolute path — pass it as `cwd` to the build command.
 */
export function createStaticExportStage(helpRoot: string): string {
  const stage = staticExportStageDirFor(helpRoot);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const entry of readdirSync(helpRoot, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    // `dereference: true` is load-bearing, not cosmetic: `helpRoot` here is often itself
    // `aida publish`'s own `.aida/publish-stage` (staging.ts), which symlinks everything
    // except `content/docs` and `public` straight back at the real help app (including `app/`)
    // to keep that stage cheap. Without dereferencing, `cpSync` would preserve `app` as a
    // symlink in *this* stage too — and the `rmSync` below, which must only ever delete this
    // throwaway copy's `app/api`/`app/studio`, would instead delete through the symlink and
    // destroy the real `app/api`/`app/studio` in the user's own help app. (Caught the hard way:
    // an early version of this function did exactly that against a scaffolded test app.)
    cpSync(join(helpRoot, entry.name), join(stage, entry.name), { recursive: true, dereference: true });
  }

  const nodeModules = join(helpRoot, "node_modules");
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, join(stage, "node_modules"), "dir");
  }

  for (const removed of [join(stage, "app", "api"), join(stage, "app", "studio")]) {
    rmSync(removed, { recursive: true, force: true });
  }

  return stage;
}
