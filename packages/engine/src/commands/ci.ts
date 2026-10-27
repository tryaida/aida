// `aida ci` (build-plan.md M18; decisions #22-23): affected -> capture -> screenshot diff ->
// one PR comment. No model, no API key. `--dry-run` writes the comment markdown + images to a
// local directory instead of pushing to GitHub — used for local testing and the end-to-end dry
// run in build-plan.md's log.
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { runCi, type RunCiOptions } from "../ci/run.js";
import type { CiResult } from "../ci/types.js";
import { buildCommentMarkdown } from "../ci/comment.js";
import { resolveOwnerRepo, pushPreviewImages, upsertPrComment, rawGithubImageUrls, type FetchFn } from "../ci/github.js";
import { createNodeCommandRunner } from "../ci/runner.js";
import { runCiPublish, type CiPublishResult } from "../ci/publish.js";
import { AppDatabaseRefusedError } from "../safety/index.js";

/**
 * Reports a run-level error. A capture safety refusal (src/safety) is printed whole, message plus
 * every suggestion, and its checks go into `--json` (already redacted: hosts and variable names
 * only); any other error keeps to its first line.
 */
function reportRunError(label: string, err: unknown, json: boolean): void {
  if (err instanceof AppDatabaseRefusedError) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: err.message, database: err.check, ...(err.outbound ? { outbound: err.outbound } : {}) }));
    } else {
      console.error(`${label} failed:\n${err.message}`);
    }
    return;
  }
  const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`${label} failed: ${message}`);
}

export interface RunCiCommandOptions {
  configPath: string;
  base: string;
  head?: string;
  prNumber?: number;
  appUrl?: string;
  appRepo?: string;
  baseline?: "disk" | "git";
  dryRun?: boolean;
  /**
   * The PR's head repo isn't this repo — a fork. GitHub always gives a fork-triggered
   * `pull_request` run a read-only `GITHUB_TOKEN`, no matter what the workflow's `permissions:`
   * block asks for, so pushing to `aida-previews` or posting a comment would just 403. Set this
   * (the generated workflow computes it from `github.event.pull_request.head.repo.full_name !=
   * github.repository`) to skip straight to the local-artifact fallback instead of trying and
   * failing. `runCiCommand` also falls back on its own if a push/comment call 403s without this
   * being set, as a second line of defence.
   */
  forkPr?: boolean;
  /** Injected in tests. */
  fetchImpl?: FetchFn;
}

export interface CiCommandResult {
  ci: CiResult;
  comment?: string;
  commentAction?: "created" | "updated" | "dry-run" | "artifact";
  /** Set alongside `commentAction: "artifact"` — where the comment markdown + images were
   * written, for the caller (the generated workflow) to `actions/upload-artifact`. */
  artifactDir?: string;
  ok: boolean;
  error?: string;
}

/** Writes the comment markdown + every image it references into `<ci.outDir>/comment/` instead
 * of calling GitHub — used by `--dry-run` and by the fork-PR / push-failure fallback, so a fork
 * PR still gets its diff as a downloadable Actions artifact instead of silently nothing. */
function writeLocalArtifact(ci: CiResult, prNumber: number | undefined, claudeActionInstalled = false): { comment: string; dir: string } {
  const localDir = join(ci.outDir, "comment");
  mkdirSync(localDir, { recursive: true });
  const images = {
    urlFor(path: string): string {
      if (!path) return "";
      const dest = join(localDir, path.split("/").slice(-2).join("__"));
      try {
        copyFileSync(path, dest);
      } catch {
        // best-effort — the comment still renders the (possibly broken) relative link
      }
      return dest;
    },
  };
  const comment = buildCommentMarkdown(ci, images, { prNumber, claudeActionInstalled });
  writeFileSync(join(localDir, "comment.md"), comment);
  return { comment, dir: localDir };
}

/** Exit non-zero over a broken walkthrough only when the repo owner opted in (`config.ci.failOnBroken`,
 * default false — docs/scope.md "Three kinds of change": a docs check shouldn't block an app
 * merge unless its owner wants it to). The PR comment flags broken walkthroughs either way. */
export async function runCiCommand(opts: RunCiCommandOptions): Promise<CiCommandResult> {
  const runOpts: RunCiOptions = {
    configPath: opts.configPath,
    base: opts.base,
    head: opts.head,
    prNumber: opts.prNumber,
    appUrl: opts.appUrl,
    appRepo: opts.appRepo,
    baseline: opts.baseline,
    dryRun: opts.dryRun,
  };
  const ci = await runCi(runOpts);
  const config = await loadConfig(opts.configPath);
  // A suspected app bug (tier "app", decision 30) fails the check just like a broken walkthrough.
  const anyBroken = ci.results.some((r) => r.tier === "broken" || r.tier === "app");
  const failOnBroken = config.ci?.failOnBroken ?? false;
  const ok = !failOnBroken || !anyBroken;
  const claudeActionInstalled = config.ci?.claudeAction ?? false;

  if (opts.dryRun) {
    const { comment } = writeLocalArtifact(ci, opts.prNumber, claudeActionInstalled);
    return { ci, comment, commentAction: "dry-run", ok };
  }

  if (!opts.prNumber) {
    return { ci, ok, error: anyBroken && failOnBroken ? "one or more walkthroughs broke" : undefined };
  }

  if (opts.forkPr) {
    const { comment, dir } = writeLocalArtifact(ci, opts.prNumber, claudeActionInstalled);
    return { ci, comment, commentAction: "artifact", artifactDir: dir, ok };
  }

  const appRepo = opts.appRepo ?? config.impact?.appRepo ?? process.cwd();
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ci, ok: false, error: "GITHUB_TOKEN not set — can't push previews or comment" };
  }
  const ownerRepo = resolveOwnerRepo(appRepo);
  const cloneUrl = `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}.git`;
  const runner = createNodeCommandRunner();

  try {
    const pushed = await pushPreviewImages(ci, { ownerRepo, token, prNumber: opts.prNumber, runner, cloneUrl });
    const images = rawGithubImageUrls(ownerRepo, "aida-previews", pushed.sha, pushed.prefix, ci.outDir);
    const comment = buildCommentMarkdown(ci, images, { prNumber: opts.prNumber, claudeActionInstalled });

    const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchFn);
    const result = await upsertPrComment(ownerRepo, opts.prNumber, comment, token, fetchImpl);

    return { ci, comment, commentAction: result.action, ok };
  } catch (err) {
    // Second line of defence: a read-only token (fork PR we didn't know about, branch
    // protection, a revoked token) 403s the push or the comment — fall back to the same local
    // artifact a declared fork PR gets, rather than failing the whole check over a comment.
    const { comment, dir } = writeLocalArtifact(ci, opts.prNumber, claudeActionInstalled);
    return { ci, comment, commentAction: "artifact", artifactDir: dir, ok, error: `GitHub push/comment failed, fell back to artifact: ${(err as Error).message.split("\n")[0]}` };
  }
}

export interface RunCiPublishCommandOptions {
  configPath: string;
  base: string;
  head?: string;
  appUrl?: string;
  appRepo?: string;
}

/** `aida ci --publish` — the merge-behaviour hook (build-plan.md M19): re-captures and
 * republishes whatever a push to main affected. No PR, no comment, no GitHub API call — the
 * generated workflow commits the result itself with its own `GITHUB_TOKEN`. */
export async function runCiPublishCli(opts: RunCiPublishCommandOptions, json: boolean): Promise<number> {
  let result: CiPublishResult;
  try {
    result = await runCiPublish(opts);
  } catch (err) {
    reportRunError("ci --publish", err, json);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  console.log(`aida ci --publish — ${result.published.length} published${result.failed.length > 0 ? `, ${result.failed.length} failed (${result.failed.join(", ")})` : ""}`);
  return result.ok ? 0 : 1;
}

export async function runCiCli(opts: RunCiCommandOptions, json: boolean): Promise<number> {
  let result: CiCommandResult;
  try {
    result = await runCiCommand(opts);
  } catch (err) {
    reportRunError("ci", err, json);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  console.log(`aida ci — base ${result.ci.base} -> head ${result.ci.head}`);
  for (const r of result.ci.results) {
    console.log(`  ${r.status.padEnd(9)} ${r.walkthrough}${r.status === "changed" ? ` (${r.changedSteps.length} step(s) changed)` : ""}`);
    if (r.failure) console.log(`    ${r.failure.summary}`);
    if (r.failure?.category === "app") console.log(`    possible app bug (not a docs problem): ${r.failure.reason ?? ""}${r.failure.evidence ? `\n    evidence: ${r.failure.evidence}` : ""}`);
    if (r.failure?.repairCommand) console.log(`    repair: ${r.failure.repairCommand}`);
  }
  if (result.ci.stalePages.length > 0) console.log(`  stale pages: ${result.ci.stalePages.join(", ")}`);
  if (result.commentAction) console.log(`  comment: ${result.commentAction}${result.artifactDir ? ` (${result.artifactDir})` : ""}`);
  if (result.error) console.error(`ci failed: ${result.error}`);
  return result.ok ? 0 : 1;
}
