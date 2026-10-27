// GitHub adapter for `aida ci` (decisions #23, #25): pushes before/after/diff images to a
// `aida-previews` orphan branch under `pr-<number>/<sha>/...`, then upserts one PR comment
// (found by its hidden marker) via the REST API. Both git and HTTP are injectable — `CommandRunner`
// (ci/runner.ts, same shape as publish/runner.ts) and a `fetch`-shaped function — so tests never
// touch a network or a real git remote, and this never operates on the caller's own checkout: all
// git plumbing runs inside a scratch directory this module creates and owns.
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { CommandRunner } from "./runner.js";
import type { CiResult, ChangedStep } from "./types.js";
import { buildCommentMarkdown, COMMENT_MARKER, type CommentImageUrls } from "./comment.js";

export interface OwnerRepo {
  owner: string;
  repo: string;
}

/** Owner/repo from `GITHUB_REPOSITORY` (set by every Actions run), falling back to the app repo's
 * `origin` remote — never hardcoded (decisions #25). `appRepo` is only used for the git-remote
 * fallback; pass the repo aida is checking, not aida's own repo. */
export function resolveOwnerRepo(appRepo: string, env: Record<string, string | undefined> = process.env): OwnerRepo {
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv && fromEnv.includes("/")) {
    const [owner, repo] = fromEnv.split("/");
    return { owner, repo };
  }
  let remote: string;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: appRepo, encoding: "utf8" }).trim();
  } catch {
    throw new Error("can't resolve owner/repo — set GITHUB_REPOSITORY or run inside a git repo with an 'origin' remote");
  }
  const match = remote.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  if (!match) throw new Error(`can't parse owner/repo from remote url: ${remote}`);
  return { owner: match[1], repo: match[2] };
}

export interface GithubCiOptions {
  ownerRepo: OwnerRepo;
  token: string;
  prNumber: number;
  /** Branch images are committed to. Default "aida-previews" (decisions #23). */
  previewBranch?: string;
  runner: CommandRunner;
}

export interface PushImagesResult {
  /** The commit sha on the previews branch the images now live at — used to build
   * `raw.githubusercontent.com` URLs. */
  sha: string;
  /** `pr-<number>/<headSha>` — the folder prefix every pushed image lives under. */
  prefix: string;
}

function run(runner: CommandRunner, cwd: string, args: string[]): Promise<void> {
  return runner("git", args, { cwd }).then((r) => {
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  });
}

/**
 * Pushes every `ChangedStep`'s before/after/diff PNG to `<previewBranch>/pr-<prNumber>/<headSha>/`
 * in the app repo, creating the orphan branch if it doesn't exist yet. Runs entirely inside a
 * scratch temp dir cloned fresh for this push — the caller's own working tree (checked out at
 * `head`, mid-build) is never touched.
 */
export async function pushPreviewImages(
  result: CiResult,
  opts: GithubCiOptions & { cloneUrl: string },
): Promise<PushImagesResult> {
  const branch = opts.previewBranch ?? "aida-previews";
  const scratch = mkdtempSync(join(tmpdir(), "aida-previews-"));
  const authedUrl = opts.cloneUrl.replace(/^https:\/\//, `https://x-access-token:${opts.token}@`);

  try {
    const cloned = await opts.runner("git", ["clone", "--branch", branch, "--single-branch", "--depth", "1", authedUrl, scratch]);
    if (cloned.code !== 0) {
      // Branch doesn't exist yet — start it as an orphan in a fresh init'd repo.
      await run(opts.runner, scratch, ["init"]);
      await run(opts.runner, scratch, ["checkout", "--orphan", branch]);
      await run(opts.runner, scratch, ["-c", "user.email=aida-ci@users.noreply.github.com", "-c", "user.name=aida-ci", "commit", "--allow-empty", "-m", "aida-previews: initial commit"]);
    }

    const prefix = `pr-${opts.prNumber}/${result.head}`;
    const destRoot = join(scratch, prefix);
    mkdirSync(destRoot, { recursive: true });

    for (const r of result.results) {
      for (const step of r.changedSteps) {
        copyIfPresent(step.before, destRoot, r.walkthrough);
        copyIfPresent(step.after, destRoot, r.walkthrough);
        copyIfPresent(step.diff, destRoot, r.walkthrough);
      }
    }

    await run(opts.runner, scratch, ["add", "-A"]);
    await run(opts.runner, scratch, ["-c", "user.email=aida-ci@users.noreply.github.com", "-c", "user.name=aida-ci", "commit", "-m", `previews for PR #${opts.prNumber} @ ${result.head}`]);
    await run(opts.runner, scratch, ["push", authedUrl, `HEAD:${branch}`]);

    const shaOut = await opts.runner("git", ["rev-parse", "HEAD"], { cwd: scratch });
    return { sha: shaOut.stdout.trim(), prefix };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `path` is already named `before-<step>.png`/`after-<step>.png`/`diff-<step>.png` (see
 * `ci/run.ts`'s `writeChangedStep`) — copied as-is under `<destRoot>/<walkthroughId>/`. */
function copyIfPresent(path: string, destRoot: string, walkthroughId: string): void {
  if (!path) return;
  const destDir = join(destRoot, walkthroughId);
  mkdirSync(destDir, { recursive: true });
  const fileName = path.split("/").pop()!;
  try {
    copyFileSync(path, join(destDir, fileName));
  } catch {
    // Source image missing (e.g. a test fixture that only exercises the comment, not real PNGs)
    // — never fail the whole push over one missing file.
  }
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

interface GithubComment {
  id: number;
  body: string;
}

/**
 * Finds the existing aida comment on the PR (by `COMMENT_MARKER`) and PATCHes it, or POSTs a
 * new one when none exists yet — so the PR gets exactly one aida comment, updated in place on
 * every push (decisions #23).
 */
export async function upsertPrComment(
  ownerRepo: OwnerRepo,
  prNumber: number,
  body: string,
  token: string,
  fetchImpl: FetchFn,
): Promise<{ action: "created" | "updated"; id: number }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const base = `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}`;

  const listResp = await fetchImpl(`${base}/issues/${prNumber}/comments?per_page=100`, { headers });
  if (!listResp.ok) throw new Error(`GitHub list comments failed: ${listResp.status}`);
  const comments = (await listResp.json()) as GithubComment[];
  const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));

  if (existing) {
    const resp = await fetchImpl(`${base}/issues/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
    if (!resp.ok) throw new Error(`GitHub update comment failed: ${resp.status}`);
    return { action: "updated", id: existing.id };
  }

  const resp = await fetchImpl(`${base}/issues/${prNumber}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!resp.ok) throw new Error(`GitHub create comment failed: ${resp.status}`);
  const created = (await resp.json()) as GithubComment;
  return { action: "created", id: created.id };
}

/** Test helper: a fake `FetchFn` backed by an in-memory comment list, so `upsertPrComment` tests
 * never hit the network. */
export function createGithubFakeFetch(initialComments: GithubComment[] = []): { fetchImpl: FetchFn; comments: GithubComment[] } {
  const comments = [...initialComments];
  let nextId = (comments.at(-1)?.id ?? 0) + 1;
  const fetchImpl: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/comments")) {
      return { ok: true, status: 200, json: async () => comments, text: async () => JSON.stringify(comments) };
    }
    if (method === "PATCH") {
      const id = Number(url.split("/").pop());
      const comment = comments.find((c) => c.id === id);
      if (comment) comment.body = JSON.parse(init!.body!).body;
      return { ok: true, status: 200, json: async () => comment, text: async () => JSON.stringify(comment) };
    }
    if (method === "POST") {
      const comment: GithubComment = { id: nextId++, body: JSON.parse(init!.body!).body };
      comments.push(comment);
      return { ok: true, status: 201, json: async () => comment, text: async () => JSON.stringify(comment) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return { fetchImpl, comments };
}

/** Builds a `CommentImageUrls` that resolves an absolute local path (as written by
 * `ci/run.ts`'s `outDir`) to its pushed location on `raw.githubusercontent.com` at the preview
 * commit sha — used once images are pushed to the previews branch. */
export function rawGithubImageUrls(ownerRepo: OwnerRepo, previewBranch: string, sha: string, prefix: string, outDir: string): CommentImageUrls {
  return {
    urlFor(path: string): string {
      const rel = path.startsWith(outDir) ? path.slice(outDir.length).replace(/^\/+/, "") : path.split("/").slice(-2).join("/");
      return `https://raw.githubusercontent.com/${ownerRepo.owner}/${ownerRepo.repo}/${sha}/${prefix}/${rel}`;
    },
  };
}

export { buildCommentMarkdown, COMMENT_MARKER };
export type { CommentImageUrls };
export type { ChangedStep };
