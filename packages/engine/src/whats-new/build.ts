// `aida whats-new [--since <ref>] [--from-github]` (docs/scope.md "Help site": "What's new
// (written from merged PRs)"; build-plan.md M21 step 4). Builds a What's New page from merge
// history on the *app* repo (not aida itself), one generated block per walkthrough bucket
// plus a trailing "general" bucket, written through the same generated/human-edit marker
// scheme every other page uses (pages/markers.ts) so a person's hand edits to the page survive
// a rerun.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { RELEASE_BASENAME, releasePublicDir } from "./published.js";
import { VIDEO_BLOCK_KEY } from "./release-text.js";
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

const VIDEO_BLOCK_RE = new RegExp(
  `(?:\\{/\\* aida:begin ${VIDEO_BLOCK_KEY} \\*/\\}|<!-- aida:begin ${VIDEO_BLOCK_KEY} -->)\\n?([\\s\\S]*?)\\n?(?:\\{/\\* aida:end ${VIDEO_BLOCK_KEY} \\*/\\}|<!-- aida:end ${VIDEO_BLOCK_KEY} -->)`,
);
const EMBED_RE = /<VideoEmbed\b[\s\S]*?\/>/;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A paragraph of a person's own words that can't point at anything a new video could take
 * away: no link, no tag or component, no file path, and not one of the generated guide lists. */
function freeStandingProse(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p) return false;
  if (/\]\(|<|\/videos\/|https?:\/\//.test(p)) return false;
  return !/^(In this video|Also changed)\b/.test(p);
}

interface VideoBlockPlan {
  /** The page text with the video block as it should be (removed, or its content replaced). */
  existing: string | undefined;
  /** The block for `mergeBlocks`, already in place in `existing` when it was there. */
  block?: GeneratedBlock;
  /** Sidecar value to record for the block: the hash of what aida last generated for it. */
  generatedHash?: string;
  suggestion?: { key: string; message: string };
}

/**
 * The release video's block (M48) as it should be written. The embed and the files it names
 * always follow the files on the site, whatever a person did to the block:
 *   - `wanted` null, or nothing passed and the staged video is gone: the block goes, edited or
 *     not (an embed of nothing helps no one);
 *   - nothing passed and the video is there: the block stays as it is (a plain `aida whats-new`
 *     never rewrites the video a `--video` run put there);
 *   - a new block: replaces an untouched one; an edited one keeps the person's words while the
 *     video is the one they edited around, with the embed refreshed; once the video changes, the
 *     generated block comes back with only their paragraphs that can't point at anything gone.
 */
function planVideoBlock(existing: string | undefined, sidecarIn: Record<string, string>, wanted: GeneratedBlock | null | undefined, videoStaged: boolean): VideoBlockPlan {
  const m = existing ? VIDEO_BLOCK_RE.exec(existing) : null;
  const known = sidecarIn[VIDEO_BLOCK_KEY];
  const replaceInner = (inner: string) =>
    m && existing
      ? `${existing.slice(0, m.index)}{/* aida:begin ${VIDEO_BLOCK_KEY} */}\n${inner}\n{/* aida:end ${VIDEO_BLOCK_KEY} */}${existing.slice(m.index + m[0].length)}`
      : existing;
  if (wanted === null || (wanted === undefined && !videoStaged)) {
    if (!m || !existing) return { existing };
    const edited = known !== undefined && sha256(m[1]) !== known;
    return {
      existing: (existing.slice(0, m.index) + existing.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n"),
      ...(edited ? { suggestion: { key: VIDEO_BLOCK_KEY, message: `"${VIDEO_BLOCK_KEY}" was edited by a person, but the release video is gone, so the block was removed.` } } : {}),
    };
  }
  if (wanted === undefined) {
    return m ? { existing, block: { key: VIDEO_BLOCK_KEY, content: m[1] }, generatedHash: known ?? sha256(m[1]) } : { existing };
  }
  const generatedHash = sha256(wanted.content);
  if (!m || !existing || sha256(m[1]) === known) return { existing: replaceInner(wanted.content), block: wanted, generatedHash };
  // Edited by a person.
  const embed = EMBED_RE.exec(wanted.content)?.[0];
  if (generatedHash === known) {
    // The same video they edited around: their words stay; the embed is always the current one.
    const inner = embed ? (EMBED_RE.test(m[1]) ? m[1].replace(EMBED_RE, () => embed) : `${embed}\n\n${m[1]}`) : m[1];
    return { existing: replaceInner(inner), block: { key: VIDEO_BLOCK_KEY, content: inner }, generatedHash };
  }
  const kept = m[1].split(/\n{2,}/).filter(freeStandingProse);
  const inner = [wanted.content, ...kept].join("\n\n");
  return {
    existing: replaceInner(inner),
    block: { key: VIDEO_BLOCK_KEY, content: inner },
    generatedHash,
    suggestion: {
      key: VIDEO_BLOCK_KEY,
      message: `"${VIDEO_BLOCK_KEY}" was edited by a person, but the release video changed, so its embed and guide list were rewritten${kept.length > 0 ? ` (${kept.length} paragraph${kept.length === 1 ? "" : "s"} of their own words kept)` : ""}.`,
    },
  };
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

  const sidecarIn = readSidecar(indexFile);
  const plan = planVideoBlock(
    existsSync(indexFile) ? readFileSync(indexFile, "utf8") : undefined,
    sidecarIn,
    opts.videoBlock,
    existsSync(join(releasePublicDir(opts.helpApp), `${RELEASE_BASENAME}.mp4`)),
  );
  const existing = plan.existing;
  // The video block is already in place in `existing`: recorded as aida's own, so the merge
  // keeps it exactly; its sidecar entry is then set to what aida last generated for it.
  const mergeSidecar = { ...sidecarIn };
  if (plan.block) mergeSidecar[VIDEO_BLOCK_KEY] = sha256(plan.block.content);
  else delete mergeSidecar[VIDEO_BLOCK_KEY];

  const blocks: GeneratedBlock[] = [buildFrontmatterBlock(), ...(plan.block ? [plan.block] : []), buildBodyBlock(buckets)];
  const merged = mergeBlocks(existing, blocks, mergeSidecar);
  const { text } = merged;
  const sidecar = { ...merged.sidecar };
  if (plan.block && plan.generatedHash) sidecar[VIDEO_BLOCK_KEY] = plan.generatedHash;
  const suggestions = [...merged.suggestions, ...(plan.suggestion ? [plan.suggestion] : [])];

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
