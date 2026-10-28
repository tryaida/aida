// `aida ci --publish` (build-plan.md M19 "Merge behaviour hook"): on a push to main (a merged
// PR), re-captures the walkthroughs the merge affected and refreshes their published
// screenshots/pages in the help app — the "cosmetic changes... refresh and publish on merge"
// half of docs/scope.md "Three kinds of change". No model, no API key, no video render (that's a
// `aida build` concern, not a CI concern — decisions #22 "CI does deterministic work only").
// The generated workflow (init/ci.ts) runs this with `GITHUB_TOKEN` and commits the result
// directly to main; this module itself never touches git.
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { computeAffected } from "../impact/index.js";
import { listWalkthroughs } from "../impact/walkthroughs.js";
import { buildPage } from "../pages/index.js";
import type { BuildPageResult } from "../pages/index.js";
import { runIndexStage } from "../build/index-stage.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import { briefForBuild, briefPath } from "../brief/consumers.js";
import { captureInPlannedOrder } from "./planned.js";
import { runCaptureSafetyChecks } from "../safety/index.js";

export interface RunCiPublishOptions {
  configPath: string;
  /** Previous commit — usually the push event's `before` sha (what main was before this merge). */
  base: string;
  /** Default `"HEAD"`. */
  head?: string;
  /** Overrides config.app.baseUrl for this run. */
  appUrl?: string;
  /** Overrides config.impact?.appRepo. Default: cwd. */
  appRepo?: string;
}

export interface CiPublishResult {
  /** Walkthroughs re-captured and republished: the affected ones plus any provider the run
   * captured for them (decision 28). */
  published: string[];
  /** Walkthroughs whose capture failed or was skipped (no capture order works, or a provider
   * failed this run) — left as whatever was last published; not an error on
   * its own (the next PR's `aida ci` already flagged it as broken before this ran). */
  failed: string[];
  /** True when `computeAffected` couldn't map the push precisely — every walkthrough was
   * republished rather than just the affected ones. */
  all: boolean;
  copiedToHelpApp: boolean;
  ok: boolean;
}

/**
 * Re-captures every walkthrough this push affected and republishes its page/screenshots into
 * `config.helpApp` (or `config.outDir` when there's no help app). Deterministic, keyless, no
 * video — `aida build` (run locally or in its own job) is still what produces the video.
 */
export async function runCiPublish(opts: RunCiPublishOptions): Promise<CiPublishResult> {
  const config = await loadConfig(opts.configPath);
  const head = opts.head ?? "HEAD";
  const appRepo = opts.appRepo ?? config.impact?.appRepo ?? process.cwd();

  const affected = await computeAffected({ appRepo, base: opts.base, head, config, app: config.impact?.app });
  const walkthroughEntries = listWalkthroughs(config.walkthroughsDir, config.buildDir);
  const idsToPublish = affected.all ? walkthroughEntries.map((w) => w.id) : affected.walkthroughs.filter((w) => w.affected).map((w) => w.id);

  // Capture safety gate (decisions #27): once, before the first capture. A refusal throws and
  // stops the whole run (reported by commands/ci.ts like any other run-level error).
  if (idsToPublish.length > 0) await runCaptureSafetyChecks(config);

  const pagesOutDir = join(config.buildDir, "ci", "pages");
  const published: string[] = [];
  const failed: string[] = [];
  const pages: BuildPageResult[] = [];
  const procedureSources: { walkthrough: Walkthrough; captureDir: string }[] = [];

  // The same capture order as the PR check (ci/planned.ts; decision 28): providers pulled in and
  // captured first, a reset only at the start of a chain, `needs`/`setup` prepared, dependants of
  // a failed provider skipped. Every walkthrough the run captured and validated is republished,
  // providers included: each was seen working against the app in this run, and the PR check
  // diffed them against the same published baseline.
  for await (const outcome of captureInPlannedOrder(config, walkthroughEntries, idsToPublish, opts.appUrl)) {
    const id = outcome.id;
    const captured = outcome.captured;
    if (!captured?.ok) {
      failed.push(id);
      continue;
    }

    let page: BuildPageResult;
    try {
      page = await buildPage(captured.walkthrough, captured.captureDir, pagesOutDir, { readers: config.readers, roles: config.roles });
    } catch {
      failed.push(id);
      continue;
    }
    if (!page.publishable) {
      failed.push(id);
      continue;
    }

    pages.push(page);
    procedureSources.push({ walkthrough: captured.walkthrough, captureDir: captured.captureDir });
    published.push(id);
  }

  // Every walkthrough on disk, loaded, as `aida build` passes them (build/pipeline.ts): each page
  // is placed by its `section:`, so a page this push didn't republish still moves when its
  // section changed (the help app sends its old `/<id>` link on to the new place), and the
  // library and home page are built from the whole set, not just this push's pages. A file that
  // doesn't load is skipped: its page stays where it is.
  const captured = new Map(procedureSources.map((s) => [s.walkthrough.walkthrough, s.walkthrough]));
  const allWalkthroughs = walkthroughEntries.flatMap((w) => {
    const done = captured.get(w.id);
    if (done) return [done];
    try {
      return [loadWalkthroughFile(w.file)];
    } catch {
      return [];
    }
  });
  // The app brief, as `aida build` publishes it; without it the index stage would drop the
  // agent connector's app overview and the home page's intro on every merge.
  const brief = briefForBuild(briefPath(config));

  const index = runIndexStage({
    pagesDir: pagesOutDir,
    outDir: config.outDir,
    helpApp: config.helpApp,
    pages,
    walkthroughIds: walkthroughEntries.map((w) => w.id),
    // Also refreshes public/screenshots + procedures.json: the PR check's disk baseline reads
    // public/screenshots, so leaving it out made every later PR diff against stale images.
    procedureSources,
    readerNames: { readers: config.readers, roles: config.roles },
    walkthroughs: allWalkthroughs,
    productName: config.brand?.name,
    appBrief: brief.artifacts,
  });

  return { published, failed, all: affected.all, copiedToHelpApp: index.copiedToHelpApp, ok: failed.length === 0 };
}
