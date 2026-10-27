// Netlify Blobs, via the `netlify-cli`'s `blobs:set` command
// (https://cli.netlify.com/commands/blobs-set/ — verify flags before a real first use; Netlify
// Blobs are more commonly written from a Function/Edge Function via `@netlify/blobs`, but the
// CLI route keeps this adapter consistent with the others).
//
// Review finding: Netlify Blobs are not publicly served by URL at all
// (https://docs.netlify.com/build/data-and-storage/netlify-blobs/ — fetched 2026-10-22: "Your
// blobs can only be accessed through your own site", via a Function, Edge Function, Build Plugin
// or the CLI — there is no public URL format). So this adapter can never hand back a usable
// public video URL for a page to link to; it refuses before uploading anything and points at
// another provider instead of guessing a URL that will 404.
import { createCliBlobAdapter } from "./cli-adapter.js";
import type { BlobAdapter, StagedVideo } from "../types.js";

const ENV_VARS = ["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID"];
const STORE = "aida-videos";

const NOT_PUBLIC_MESSAGE =
  'Netlify Blobs have no public URL — they\'re only readable from your own site (a Function, Edge Function, or the CLI), never by a direct link a help page can use. Serve videos via a host route instead (e.g. a Function that streams the blob), or pick a different `publish.videoStorage` provider (vercel-blob, r2, s3, or supabase-storage) that returns a public URL.';

export function createNetlifyBlobsAdapter(env: Record<string, string | undefined> = process.env): BlobAdapter {
  return createCliBlobAdapter(
    {
      name: "netlify-blobs",
      envVars: ENV_VARS,
      command: (file: StagedVideo) => ({
        cmd: "npx",
        args: ["--yes", "netlify-cli", "blobs:set", STORE, file.relPath, file.absPath, "--input-type=path"],
        description: `upload ${file.relPath} to the Netlify Blobs "${STORE}" store`,
      }),
      preflight: () => {
        throw new Error(NOT_PUBLIC_MESSAGE);
      },
      urlFor: () => {
        throw new Error(NOT_PUBLIC_MESSAGE);
      },
    },
    env,
  );
}
