// Shared types for `aida publish --to <host>` (docs/build-plan.md M13; docs/scope.md "Runs on
// Node, deploys like any Next.js app", "Preview, then publish", "Safety and trust"; decisions
// #16-18). A host adapter never shells out directly — every external command goes through an
// injectable `CommandRunner` so tests can assert on the exact command without a network call or
// a real CLI installed, and `apply()` never overwrites a file the user has already changed
// (docs/scope.md "Locks": "Rebuilds ... never overwrite").
import type { ResolvedConfig } from "../config/index.js";

/** Result of running one external command (a host or blob provider's own CLI). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one external command and resolves with its result instead of throwing on a non-zero
 * exit — callers decide what a failure means. The default (`createNodeCommandRunner`) shells
 * out for real; tests always inject a fake so `aida publish` is fully testable offline and
 * never actually deploys anything during `npm test`.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<RunResult>;

export type HostName = "vercel" | "netlify" | "amplify" | "cloudflare" | "node" | "static";

export type BlobProviderName = "vercel-blob" | "s3" | "netlify-blobs" | "r2" | "supabase-storage";

/** A host config file a `plan()` would write, relative to the help app root. */
export interface PlannedFile {
  path: string;
  contents: string;
  reason: string;
}

/** A command a `plan()`/`deploy()` would run — printed in `--dry-run`, actually run by `deploy()`. */
export interface PlannedCommand {
  cmd: string;
  args: string[];
  description: string;
  /** Extra env vars this command needs beyond the inherited process env (e.g. the static
   * adapter's `AIDA_STATIC_EXPORT=1`, which the help app's chat/MCP routes read to answer
   * 501 instead of being compiled as dynamic routes into a static export). `deploy()` must
   * pass this to the `CommandRunner`, not just show it here. */
  env?: Record<string, string>;
}

/** An env var / secret a host or blob adapter needs — name only, never a value (docs/scope.md
 * "Safety and trust": "Secrets ... live in CI or host secrets, never in the repo or the output"). */
export interface SecretRequirement {
  name: string;
  why: string;
}

export interface PublishPlan {
  host: HostName;
  /** True when video total size exceeds the host's static-asset limit, or `publish.videoStorage`
   * is set — the staged copy's video URLs get rewritten to blob storage before deploy. */
  useBlobStorage: boolean;
  blobProvider?: BlobProviderName;
  files: PlannedFile[];
  commands: PlannedCommand[];
  secrets: SecretRequirement[];
  /** True when this host has no CLI deploy and `deploy()` only explains the Git-integration route. */
  gitIntegration: boolean;
  warnings: string[];
  notes: string[];
}

export interface ApplyFileResult {
  path: string;
  action: "written" | "skipped";
  reason?: string;
}

export interface ApplyResult {
  files: ApplyFileResult[];
}

export interface DeployOptions {
  prod?: boolean;
  dryRun?: boolean;
}

export interface DeployResult {
  ok: boolean;
  url?: string;
  summary: string;
  ran: RunResult[];
}

export interface HostAdapter {
  name: HostName;
  /** Whether chat and the MCP route work on this host (false only for `static`). */
  supportsChatAndMcp: boolean;
  /** Per-file byte limit this host enforces on static assets, if any — see `publish/video-size.ts`. */
  staticAssetLimitBytes?: number;
  plan(helpRoot: string, config: ResolvedConfig): Promise<PublishPlan> | PublishPlan;
  apply(helpRoot: string, plan: PublishPlan): Promise<ApplyResult> | ApplyResult;
  deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult>;
}

/** One video file staged for upload, found under the help app's content by `video-size.ts`. */
export interface StagedVideo {
  /** Absolute path, inside the staged copy. */
  absPath: string;
  /** Path relative to the help app root, e.g. `public/videos/add-entry.mp4`. */
  relPath: string;
  bytes: number;
}

export interface BlobUploadResult {
  url: string;
  key: string;
  bytes: number;
}

export interface BlobAdapter {
  name: BlobProviderName;
  /** Env var names this provider needs — names only, see `SecretRequirement`. */
  envVars: string[];
  /** Commands `upload()` would run for this file, for `--dry-run` / plan display. */
  plan(file: StagedVideo): PlannedCommand[];
  upload(file: StagedVideo, runner: CommandRunner): Promise<BlobUploadResult>;
}
