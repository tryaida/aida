// Vercel Blob. The Vercel CLI (as of the `vercel` CLI docs fetched 2026-10-22,
// https://vercel.com/docs/cli) has no documented direct-upload subcommand for arbitrary files —
// uploads normally go through the `@vercel/blob` SDK's `put()` at runtime. This adapter shells
// out to `npx` running that SDK inline so `upload()` still fits the CommandRunner shape every
// other adapter uses; verify against `@vercel/blob`'s current API before a real first use, and
// add it as a dependency then (not added here to keep the engine installable offline).
//
// `put()`'s resolved value (https://vercel.com/docs/vercel-blob/using-blob-sdk fetched
// 2026-10-22, "JS SDK Reference") is `{ url, downloadUrl, pathname, contentType,
// contentDisposition }` — `url` includes a randomized suffix Vercel assigns at upload time (e.g.
// `https://<store id>.public.blob.vercel-storage.com/<pathname>-<random suffix>`), which nothing
// can predict ahead of time. So the inline script prints that result as JSON on stdout, and
// `urlFor` parses it out of the actual upload, rather than guessing a URL shape that would be
// wrong (review finding).
import { createCliBlobAdapter } from "./cli-adapter.js";
import type { BlobAdapter, RunResult, StagedVideo } from "../types.js";

const ENV_VARS = ["BLOB_READ_WRITE_TOKEN"];

export function createVercelBlobAdapter(env: Record<string, string | undefined> = process.env): BlobAdapter {
  return createCliBlobAdapter(
    {
      name: "vercel-blob",
      envVars: ENV_VARS,
      command: (file: StagedVideo) => ({
        cmd: "npx",
        args: [
          "--yes",
          "-p",
          "@vercel/blob",
          "node",
          "-e",
          `require('@vercel/blob').put(${JSON.stringify(file.relPath)}, require('fs').readFileSync(${JSON.stringify(file.absPath)}), { access: 'public' }).then((r) => { process.stdout.write(JSON.stringify(r)); }).catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); })`,
        ],
        description: `upload ${file.relPath} to Vercel Blob (needs BLOB_READ_WRITE_TOKEN)`,
      }),
      urlFor: (file: StagedVideo, _env, result: RunResult) => {
        let parsed: { url?: unknown } | undefined;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          // fall through to the error below
        }
        if (!parsed || typeof parsed.url !== "string" || !parsed.url) {
          throw new Error(
            `vercel-blob upload of ${file.relPath} did not print a parseable { url } on stdout (got: ${result.stdout.slice(0, 200)}) — can't determine its real public URL.`,
          );
        }
        return parsed.url;
      },
    },
    env,
  );
}
