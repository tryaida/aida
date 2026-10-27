// `aida publish --to <host> [--prod] [--dry-run] [--json]` (docs/build-plan.md M13; docs/scope.md
// "Preview, then publish", "Safety and trust"; decisions #16-18). `--dry-run` only builds and
// prints the plan — no gate, no file write, no deploy. A real run gates on the last `aida
// build` report and every page's publishable status, then (production only) a person's prior
// approval, before writing host config files and deploying through the host's own CLI.
import { loadConfig } from "../config/index.js";
import { findHelpRoot } from "../edit/help-root.js";
import { getHostAdapter } from "../publish/hosts/registry.js";
import { buildPublishPlan } from "../publish/plan.js";
import { checkApproval, checkBuildReport, checkPagesPublishable } from "../publish/gates.js";
import { createNodeCommandRunner } from "../publish/runner.js";
import { getBlobAdapter } from "../publish/blob/registry.js";
import { createStage, dropStagedVideos, rewriteVideoLinksInStage } from "../publish/staging.js";
import type { BlobUploadResult, CommandRunner, DeployResult, PublishPlan, StagedVideo } from "../publish/types.js";

export interface RunPublishOptions {
  configPath: string;
  to?: string;
  prod?: boolean;
  dryRun?: boolean;
  approve?: boolean;
  approveBy?: string;
  /** Injected in tests; defaults to the real shell-out runner. */
  runner?: CommandRunner;
  /** Injected in tests; defaults to `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** Injected in tests (so a real agent-session env, e.g. this very process, never leaks into
   * `checkApproval`'s agent detection); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface PublishResult {
  host: string;
  prod: boolean;
  dryRun: boolean;
  plan?: PublishPlan;
  gates?: { ok: boolean; reasons: string[] };
  apply?: { files: { path: string; action: string; reason?: string }[] };
  uploads?: BlobUploadResult[];
  deploy?: DeployResult;
  ok: boolean;
  error?: string;
}

export async function runPublishCommand(opts: RunPublishOptions): Promise<PublishResult> {
  const config = await loadConfig(opts.configPath);
  const helpRoot = findHelpRoot(config.configDir);
  const host = opts.to ?? config.host;
  if (!host) {
    return fail("no host given — pass --to <host> or set `host` in aida.config.ts");
  }

  const adapter = getHostAdapter(host);
  const { plan } = await buildPublishPlan(helpRoot, config, adapter);

  if (opts.dryRun) {
    return { host, prod: Boolean(opts.prod), dryRun: true, plan, ok: true };
  }

  const buildGate = checkBuildReport(config.buildDir);
  const pagesGate = checkPagesPublishable(helpRoot);
  const reasons = [...buildGate.reasons, ...pagesGate.reasons];

  const approvalGate = await checkApproval(helpRoot, {
    prod: Boolean(opts.prod),
    host,
    approve: opts.approve,
    approveBy: opts.approveBy,
    isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
    env: opts.env,
  });
  if (approvalGate.warning) console.error(approvalGate.warning);
  reasons.push(...approvalGate.reasons);

  if (reasons.length > 0) {
    return {
      host,
      prod: Boolean(opts.prod),
      dryRun: false,
      plan,
      gates: { ok: false, reasons },
      ok: false,
      error: reasons.join("; "),
    };
  }

  const apply = await adapter.apply(helpRoot, plan);

  // `createStage` must run after `apply()` (above), so the stage picks up any host config files
  // apply() just wrote to helpRoot, and `deploy()` (below) must run against the stage, not
  // helpRoot — otherwise rewritten blob video/caption URLs never ship and oversized videos in
  // public/ still deploy as static assets (review finding).
  let uploads: BlobUploadResult[] | undefined;
  const runner = opts.runner ?? createNodeCommandRunner();
  const stage = createStage(helpRoot);

  if (plan.useBlobStorage && plan.blobProvider) {
    const { findStagedVideos, findCaptionsFor } = await import("../publish/video-size.js");
    const videos: StagedVideo[] = findStagedVideos(helpRoot);
    const blob = getBlobAdapter(plan.blobProvider);
    uploads = [];
    const uploadMap = new Map<string, BlobUploadResult>();
    const media: StagedVideo[] = [];
    for (const video of videos) {
      const result = await blob.upload(video, runner);
      uploads.push(result);
      uploadMap.set(video.relPath, result);
      media.push(video);
      // Captions never shipped unrewritten: each gets its own blob upload and its own URL,
      // never silently aliased to the video's URL (review finding).
      for (const caption of findCaptionsFor(helpRoot, video)) {
        const captionResult = await blob.upload(caption, runner);
        uploads.push(captionResult);
        uploadMap.set(caption.relPath, captionResult);
        media.push(caption);
      }
    }
    rewriteVideoLinksInStage(helpRoot, stage, media, uploadMap);
    // The local copies are now dead weight (and may be oversized for the host's static-asset
    // limit) now that pages point at the blob URLs — drop them from the staged copy so they
    // never ship.
    dropStagedVideos(stage, videos);
  }

  const deploy = await adapter.deploy(stage, plan, { prod: opts.prod, dryRun: false }, runner);

  return {
    host,
    prod: Boolean(opts.prod),
    dryRun: false,
    plan,
    gates: { ok: true, reasons: [] },
    apply,
    uploads,
    deploy,
    ok: deploy.ok,
  };
}

function fail(error: string): PublishResult {
  return { host: "", prod: false, dryRun: false, ok: false, error };
}

export async function runPublish(opts: RunPublishOptions, json: boolean): Promise<number> {
  let result: PublishResult;
  try {
    result = await runPublishCommand(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`publish failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  if (!result.plan) {
    console.error(`publish failed: ${result.error}`);
    return 1;
  }

  console.log(`aida publish — host: ${result.host}${result.dryRun ? " (dry run)" : ""}${result.prod ? " [production]" : ""}`);
  if (result.dryRun) {
    printPlan(result.plan);
    return 0;
  }

  if (result.gates && !result.gates.ok) {
    console.error("publish refused:");
    for (const r of result.gates.reasons) console.error(`  - ${r}`);
    return 1;
  }

  if (result.apply) {
    for (const f of result.apply.files) {
      console.log(`  ${f.action === "written" ? "wrote" : "skipped"} ${f.path}${f.reason ? ` (${f.reason})` : ""}`);
    }
  }
  if (result.uploads) {
    for (const u of result.uploads) console.log(`  uploaded ${u.key} -> ${u.url}`);
  }
  if (result.deploy) {
    console.log(result.deploy.ok ? `deploy ok: ${result.deploy.summary}` : `deploy FAILED: ${result.deploy.summary}`);
  }

  return result.ok ? 0 : 1;
}

function printPlan(plan: PublishPlan): void {
  console.log(`  files to write:`);
  for (const f of plan.files) console.log(`    ${f.path} — ${f.reason}`);
  console.log(`  commands:`);
  for (const c of plan.commands) console.log(`    ${c.cmd} ${c.args.join(" ")} — ${c.description}`);
  if (plan.secrets.length > 0) {
    console.log(`  secrets needed (names only):`);
    for (const s of plan.secrets) console.log(`    ${s.name} — ${s.why}`);
  }
  if (plan.useBlobStorage) console.log(`  videos: uploaded via ${plan.blobProvider}`);
  if (plan.gitIntegration) console.log(`  deploy route: Git integration (see notes)`);
  for (const w of plan.warnings) console.log(`  warning: ${w}`);
  for (const n of plan.notes) console.log(`  note: ${n}`);
}
