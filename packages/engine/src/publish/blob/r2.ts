// Cloudflare R2, via `wrangler r2 object put` (https://developers.cloudflare.com/r2/reference/wrangler-commands/#put — fetched 2026-10-22).
//
// R2's public URL is not derivable from the bucket name (review finding): the "Public Development
// URL" Cloudflare assigns a bucket is a Cloudflare-managed `r2.dev` subdomain
// (https://developers.cloudflare.com/r2/buckets/public-buckets/ — fetched 2026-10-22), not
// `<bucket>.r2.dev` as this adapter previously guessed, and Cloudflare's own docs recommend a
// custom domain for anything beyond non-production use anyway. Neither is knowable from
// `AIDA_R2_BUCKET` alone, so this adapter requires a configured `AIDA_R2_PUBLIC_BASE_URL`
// (the bucket's actual r2.dev URL or a custom domain) and refuses before uploading anything if
// it's missing, rather than ship a guessed, possibly-wrong URL.
import { createCliBlobAdapter } from "./cli-adapter.js";
import type { BlobAdapter, StagedVideo } from "../types.js";

const ENV_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AIDA_R2_BUCKET", "AIDA_R2_PUBLIC_BASE_URL"];

export function createR2BlobAdapter(env: Record<string, string | undefined> = process.env): BlobAdapter {
  return createCliBlobAdapter(
    {
      name: "r2",
      envVars: ENV_VARS,
      command: (file: StagedVideo, e) => {
        const bucket = e.AIDA_R2_BUCKET ?? "<bucket>";
        return {
          cmd: "npx",
          args: ["--yes", "wrangler", "r2", "object", "put", `${bucket}/${file.relPath}`, "--file", file.absPath, "--remote"],
          description: `upload ${file.relPath} to R2 bucket "${bucket}"`,
        };
      },
      preflight: (_file, e) => {
        if (!e.AIDA_R2_PUBLIC_BASE_URL) {
          throw new Error(
            "R2 has no public URL derivable from the bucket name — set AIDA_R2_PUBLIC_BASE_URL to this bucket's actual " +
              "Public Development URL (a Cloudflare-managed r2.dev subdomain, see the bucket's settings) or a custom domain " +
              "connected to it, before publishing videos to r2.",
          );
        }
      },
      urlFor: (file: StagedVideo, e) => {
        // `preflight` already guarantees this is set by the time `urlFor` runs.
        const base = e.AIDA_R2_PUBLIC_BASE_URL!.replace(/\/+$/, "");
        return `${base}/${file.relPath}`;
      },
    },
    env,
  );
}
