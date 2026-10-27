// Builds the full publish plan for one host: the host adapter's own plan, plus the blob-storage
// decision (docs/build-plan.md M13 "video to blob storage") layered on top.
import type { ResolvedConfig } from "../config/index.js";
import { defaultBlobProviderFor } from "./blob/registry.js";
import { findStagedVideos, needsBlobStorage } from "./video-size.js";
import type { HostAdapter, PublishPlan, StagedVideo } from "./types.js";

export interface BuildPlanResult {
  plan: PublishPlan;
  videos: StagedVideo[];
}

export async function buildPublishPlan(
  helpRoot: string,
  config: ResolvedConfig,
  host: HostAdapter,
): Promise<BuildPlanResult> {
  const plan = await host.plan(helpRoot, config);
  const videos = findStagedVideos(helpRoot);
  const forced = Boolean(config.publish?.videoStorage);
  const useBlobStorage = needsBlobStorage(videos, host.staticAssetLimitBytes, forced);

  if (useBlobStorage) {
    const blobProvider = config.publish?.videoStorage ?? defaultBlobProviderFor(host.name);
    plan.useBlobStorage = true;
    plan.blobProvider = blobProvider;
    const over = videos.filter((v) => host.staticAssetLimitBytes && v.bytes > host.staticAssetLimitBytes);
    plan.notes.push(
      over.length > 0
        ? `${over.length} video(s) exceed ${host.name}'s ${(host.staticAssetLimitBytes! / 1024 / 1024).toFixed(0)} MiB/file limit — uploading to ${blobProvider} instead of shipping them as static assets.`
        : `publish.videoStorage is set to "${blobProvider}" — uploading videos there instead of shipping them as static assets.`,
    );
  }

  return { plan, videos };
}
