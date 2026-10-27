// `aida publish --to static` builds from a staged copy with app/api and app/studio removed,
// never the user's own help app — see src/publish/static-export-stage.ts's doc comment for why
// (Next's static export fails the whole build the moment it finds either tree: chat/MCP's
// POST/DELETE handlers can't run without a server at all, and every Studio API route is
// dev-only but still visited at build time).
import { existsSync, mkdirSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticExportStage, staticExportStageDirFor } from "../../src/publish/static-export-stage.js";
import { cleanupTmpDirs, makeHelpRoot } from "./helpers.js";

afterEach(cleanupTmpDirs);

/** Lays out just enough of a help app for the stage builder to have something real to move:
 * app/api, app/studio, an ordinary page, public assets and (optionally) node_modules. */
function makeFullHelpApp(): string {
  const helpRoot = makeHelpRoot();
  mkdirSync(join(helpRoot, "app", "api", "chat"), { recursive: true });
  writeFileSync(join(helpRoot, "app", "api", "chat", "route.ts"), "export async function POST() {}\n");
  mkdirSync(join(helpRoot, "app", "studio", "api", "history"), { recursive: true });
  writeFileSync(join(helpRoot, "app", "studio", "api", "history", "route.ts"), "export async function GET() {}\n");
  mkdirSync(join(helpRoot, "app", "(site)"), { recursive: true });
  writeFileSync(join(helpRoot, "app", "(site)", "page.tsx"), "export default function Page() { return null; }\n");
  writeFileSync(join(helpRoot, "package.json"), JSON.stringify({ name: "help-app" }));
  return helpRoot;
}

describe("createStaticExportStage", () => {
  it("removes app/api and app/studio from the staged copy, keeping the rest", () => {
    const helpRoot = makeFullHelpApp();
    const stage = createStaticExportStage(helpRoot);

    expect(stage).toBe(staticExportStageDirFor(helpRoot));
    expect(existsSync(join(stage, "app", "api"))).toBe(false);
    expect(existsSync(join(stage, "app", "studio"))).toBe(false);
    expect(existsSync(join(stage, "app", "(site)", "page.tsx"))).toBe(true);
    expect(existsSync(join(stage, "package.json"))).toBe(true);
    expect(existsSync(join(stage, "next.config.mjs"))).toBe(true);
  });

  it("never touches the user's own app/api or app/studio", () => {
    const helpRoot = makeFullHelpApp();
    createStaticExportStage(helpRoot);

    expect(existsSync(join(helpRoot, "app", "api", "chat", "route.ts"))).toBe(true);
    expect(existsSync(join(helpRoot, "app", "studio", "api", "history", "route.ts"))).toBe(true);
  });

  it("symlinks node_modules instead of copying it", () => {
    const helpRoot = makeFullHelpApp();
    mkdirSync(join(helpRoot, "node_modules", "next"), { recursive: true });
    writeFileSync(join(helpRoot, "node_modules", "next", "package.json"), "{}");

    const stage = createStaticExportStage(helpRoot);

    const linked = join(stage, "node_modules");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked, "next", "package.json"), "utf8")).toBe("{}");
  });

  it("is a no-op for node_modules when the help app has none installed yet", () => {
    const helpRoot = makeFullHelpApp();
    const stage = createStaticExportStage(helpRoot);
    expect(existsSync(join(stage, "node_modules"))).toBe(false);
  });

  it("overwrites a previous stage rather than merging into it", () => {
    const helpRoot = makeFullHelpApp();
    createStaticExportStage(helpRoot);
    const stage = staticExportStageDirFor(helpRoot);
    writeFileSync(join(stage, "stale-marker.txt"), "leftover from a previous run");

    createStaticExportStage(helpRoot);

    expect(existsSync(join(stage, "stale-marker.txt"))).toBe(false);
  });

  it("re-running the stage builder is safe (never copies its own previous output into itself)", () => {
    const helpRoot = makeFullHelpApp();
    createStaticExportStage(helpRoot);
    expect(() => createStaticExportStage(helpRoot)).not.toThrow();
  });

  it("regression: dereferences a symlinked app/ before removing api/studio, never deleting through the link into the real app", () => {
    // Reproduces `aida publish`'s real call shape: commands/publish.ts passes this function
    // staging.ts's own `.aida/publish-stage`, whose `app` (etc.) is a *symlink* back at the
    // real help app, not a real directory — only content/docs and public are deep-copied there.
    // Caught for real: an earlier version of createStaticExportStage, given a helpRoot shaped
    // like this, deleted the real help app's app/api and app/studio instead of its own
    // throwaway copy, because `cpSync` preserves symlinks by default.
    const realHelpRoot = makeFullHelpApp();
    const outerStage = join(realHelpRoot, ".aida", "publish-stage");
    mkdirSync(outerStage, { recursive: true });
    symlinkSync(join(realHelpRoot, "app"), join(outerStage, "app"), "dir");
    symlinkSync(join(realHelpRoot, "next.config.mjs"), join(outerStage, "next.config.mjs"));
    symlinkSync(join(realHelpRoot, "package.json"), join(outerStage, "package.json"));
    mkdirSync(join(outerStage, "content", "docs"), { recursive: true });
    mkdirSync(join(outerStage, "public"), { recursive: true });

    const innerStage = createStaticExportStage(outerStage);

    // The real help app's app/api and app/studio must survive untouched.
    expect(existsSync(join(realHelpRoot, "app", "api", "chat", "route.ts"))).toBe(true);
    expect(existsSync(join(realHelpRoot, "app", "studio", "api", "history", "route.ts"))).toBe(true);
    // The inner stage still did its job: api/studio removed there, the rest of app/ present.
    expect(existsSync(join(innerStage, "app", "api"))).toBe(false);
    expect(existsSync(join(innerStage, "app", "studio"))).toBe(false);
    expect(existsSync(join(innerStage, "app", "(site)", "page.tsx"))).toBe(true);
    // And it's a real copy, not a symlink, in the inner stage.
    expect(lstatSync(join(innerStage, "app")).isSymbolicLink()).toBe(false);
  });
});
