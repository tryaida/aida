// `aida version freeze <name>` (build-plan.md M21 step 1): snapshots the current build's
// search-index.json, procedures.json and llms.txt into `public/versions/<name>/`, and records
// the version in `public/versions.json`. Deliberately cheap and self-contained:
//
// - Screenshots and videos are NOT copied — a frozen version's pages (served via the version
//   route, help-app/app/(site)/v/[version]/[[...slug]]) reference the *current* build's
//   `/screenshots/...` and blob-stored video URLs. This is a real trade-off: a screenshot that's
//   since changed shape will show the current one under an old version's text, and a video
//   whose blob URL stops resolving breaks that old version's video link. Freezing is "cheap and
//   static-friendly" (docs/build-plan.md M21) at the cost of binary assets not being frozen too;
//   a future milestone could copy screenshots into the snapshot if that trade-off turns out to
//   matter in practice.
// - The page Markdown itself IS frozen, via llms.txt (one section per page, markers already
//   stripped) — enough for the version route to render old wording even after `content/docs`
//   has moved on.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest } from "./manifest.js";
import type { FreezeVersionOptions, FreezeVersionResult } from "./types.js";

/** Snapshot files taken verbatim from `public/` — the same files the chat and MCP routes already
 * read at request time (help-app/app/api/chat/route.ts, app/api/mcp/route.ts). */
const SNAPSHOT_FILES = ["search-index.json", "procedures.json", "llms.txt"];

export function freezeVersion(opts: FreezeVersionOptions): FreezeVersionResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.name) || opts.name === "latest") {
    throw new Error(`version name "${opts.name}" must be letters, digits, ".", "_" or "-" (and not "latest")`);
  }
  const publicDir = join(opts.helpApp, "public");
  const dir = join(publicDir, "versions", opts.name);

  if (existsSync(dir) && !opts.force) {
    throw new Error(`version "${opts.name}" already exists at ${dir} — pass force to overwrite`);
  }

  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  for (const file of SNAPSHOT_FILES) {
    const src = join(publicDir, file);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, file));
    files.push(file);
  }

  const manifest = readManifest(publicDir) ?? { latest: opts.name, versions: [] };
  manifest.versions = manifest.versions.filter((v) => v.name !== opts.name);
  manifest.versions.push({
    name: opts.name,
    date: (opts.now ? opts.now() : new Date()).toISOString(),
    gitRef: opts.gitRef,
  });
  manifest.latest = opts.name;
  writeManifest(publicDir, manifest);

  return { name: opts.name, dir, manifestFile: join(publicDir, "versions.json"), files };
}
