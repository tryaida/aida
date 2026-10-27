// `aida whats-new [--since <ref>] [--from-github]` (docs/scope.md "Help site": "What's new
// (written from merged PRs)"; build-plan.md M21 step 4). Builds a What's New page from merge
// history on the *app* repo (not aida itself), one generated block per walkthrough bucket
// plus a trailing "general" bucket, written through the same generated/human-edit marker
// scheme every other page uses (pages/markers.ts) so a person's hand edits to the page survive
// a rerun.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FRONTMATTER_KEY,
  mergeBlocks,
  readSidecar,
  sidecarPath,
  writeSidecar,
  type GeneratedBlock,
} from "../pages/markers.js";
import { readManifest } from "../versions/index.js";
import { isNoiseCommit } from "./filter.js";
import { bucketByWalkthrough, groupByWalkthrough } from "./group.js";
import { listMergedCommits, listMergedPullRequests } from "./sources.js";
import type { BuildWhatsNewOptions, BuildWhatsNewResult, GroupedEntry } from "./types.js";

/** Default `--since`: the last frozen version's `gitRef`, when one was recorded (so each
 * `whats-new` run naturally picks up from wherever the last release tag left off). `undefined`
 * (whole history) when no version has ever been frozen. */
function defaultSince(helpApp: string): string | undefined {
  const manifest = readManifest(join(helpApp, "public"));
  if (!manifest || manifest.versions.length === 0) return undefined;
  const last = manifest.versions[manifest.versions.length - 1];
  return last.gitRef;
}

function bucketHeading(walkthroughId: string | undefined): string {
  return walkthroughId ? `### ${walkthroughId}` : "### General";
}

function renderEntry(entry: GroupedEntry): string {
  const date = entry.date.slice(0, 10);
  const link = entry.url ? `[${entry.text}](${entry.url})` : entry.prNumber ? `${entry.text} (#${entry.prNumber})` : entry.text;
  return `- ${date} — ${link}`;
}

function buildBodyBlock(buckets: { walkthroughId?: string; entries: GroupedEntry[] }[]): GeneratedBlock {
  const sections = buckets.map((bucket) => [bucketHeading(bucket.walkthroughId), ...bucket.entries.map(renderEntry)].join("\n"));
  const content = sections.length > 0 ? sections.join("\n\n") : "Nothing new since the last update.";
  return { key: "whats-new", content };
}

function buildFrontmatterBlock(): GeneratedBlock {
  return { key: FRONTMATTER_KEY, content: `---\ntitle: "What's new"\npassed: true\n---` };
}

/**
 * Runs the whole whats-new pipeline: fetch merge history (git log or `gh pr list`, per
 * `opts.fromGithub`) -> drop chore/CI/deps noise -> plain-words + walkthrough grouping ->
 * render -> merge into `content/docs/whats-new/index.mdx` through the generated-block markers.
 */
export async function buildWhatsNew(opts: BuildWhatsNewOptions): Promise<BuildWhatsNewResult> {
  const since = opts.since ?? defaultSince(opts.helpApp);

  const rawEntries = opts.fromGithub
    ? await listMergedPullRequests(opts.runner, opts.appRepo, since)
    : await listMergedCommits(opts.runner, opts.appRepo, since);

  const skippedCount = rawEntries.filter((e) => isNoiseCommit(e.subject)).length;
  const noteworthy = rawEntries.filter((e) => !isNoiseCommit(e.subject));
  const grouped = groupByWalkthrough(noteworthy, opts.mapper);
  const buckets = bucketByWalkthrough(grouped);

  const pageDir = join(opts.helpApp, "content", "docs", "whats-new");
  mkdirSync(pageDir, { recursive: true });
  const indexFile = join(pageDir, "index.mdx");
  const plainFile = join(pageDir, "index.plain.md");

  const existing = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : undefined;
  const sidecarIn = readSidecar(indexFile);

  const blocks: GeneratedBlock[] = [buildFrontmatterBlock(), buildBodyBlock(buckets)];
  const { text, sidecar, suggestions } = mergeBlocks(existing, blocks, sidecarIn);

  writeFileSync(indexFile, text.endsWith("\n") ? text : `${text}\n`);
  // No `index.plain.md` here: this folder is the site's content tree, where Fumadocs would serve
  // it as a second page (`/whats-new/index.plain`). Remove one an older version wrote.
  rmSync(plainFile, { force: true });
  writeSidecar(indexFile, sidecar);

  return {
    pageFile: indexFile,
    entryCount: grouped.length,
    skippedCount,
    since,
    suggestions: suggestions.map((s) => ({ key: s.key, message: s.message })),
  };
}
