import type { BlobAdapter, BlobProviderName } from "../types.js";
import { createDryRunBlobAdapter } from "./dry-run.js";
import { createVercelBlobAdapter } from "./vercel-blob.js";
import { createS3BlobAdapter } from "./s3.js";
import { createNetlifyBlobsAdapter } from "./netlify-blobs.js";
import { createR2BlobAdapter } from "./r2.js";
import { createSupabaseStorageAdapter } from "./supabase-storage.js";

const factories: Record<BlobProviderName, () => BlobAdapter> = {
  "vercel-blob": () => createVercelBlobAdapter(),
  s3: () => createS3BlobAdapter(),
  "netlify-blobs": () => createNetlifyBlobsAdapter(),
  r2: () => createR2BlobAdapter(),
  "supabase-storage": () => createSupabaseStorageAdapter(),
};

/** Looks up a blob provider by name. `dryRun: true` (the default for `--dry-run` and every
 * test) ignores `name` and always returns the dry-run adapter, which never shells out. */
export function getBlobAdapter(name: BlobProviderName, opts: { dryRun?: boolean } = {}): BlobAdapter {
  if (opts.dryRun) return createDryRunBlobAdapter();
  const factory = factories[name];
  if (!factory) throw new Error(`Unknown blob provider "${name}". Known: ${Object.keys(factories).join(", ")}`);
  return factory();
}

/** The default blob provider for a host, when `publish.videoStorage` isn't set explicitly. */
export function defaultBlobProviderFor(host: string): BlobProviderName {
  switch (host) {
    case "vercel":
      return "vercel-blob";
    case "netlify":
      return "netlify-blobs";
    case "cloudflare":
      return "r2";
    default:
      return "s3";
  }
}

export function listBlobProviders(): BlobProviderName[] {
  return Object.keys(factories) as BlobProviderName[];
}
