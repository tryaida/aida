// Shared shape for a blob provider whose upload is "run this CLI command" — every real adapter
// in this directory is this shape; only the command and URL format differ. Adapters never shell
// out directly: `upload()` takes a `CommandRunner` so `npm test` never actually uploads anything.
import type { BlobAdapter, BlobProviderName, CommandRunner, PlannedCommand, RunResult, StagedVideo } from "../types.js";

export interface CliBlobAdapterSpec {
  name: BlobProviderName;
  envVars: string[];
  command(file: StagedVideo, env: Record<string, string | undefined>): PlannedCommand;
  /**
   * Checked before the upload command runs at all — throw here when this provider/config
   * combination can never produce a usable public URL (review finding: Netlify Blobs aren't
   * publicly served by URL at all; R2/S3-compatible storage needs a configured `publicBaseUrl`
   * — there's nothing deterministic to guess it from). Not called by `plan()`, only `upload()`.
   */
  preflight?(file: StagedVideo, env: Record<string, string | undefined>): void;
  /**
   * The file's real public URL once uploaded. Given the upload command's own `RunResult` so a
   * provider that returns its assigned URL on stdout (e.g. Vercel Blob's `put()`, which includes
   * a randomized suffix no formula can predict) can parse it out, instead of guessing a URL that
   * may not match what was actually assigned.
   */
  urlFor(file: StagedVideo, env: Record<string, string | undefined>, result: RunResult): string;
}

export function createCliBlobAdapter(spec: CliBlobAdapterSpec, env: Record<string, string | undefined> = process.env): BlobAdapter {
  return {
    name: spec.name,
    envVars: spec.envVars,
    plan(file: StagedVideo): PlannedCommand[] {
      return [spec.command(file, env)];
    },
    async upload(file: StagedVideo, runner: CommandRunner) {
      spec.preflight?.(file, env);
      const planned = spec.command(file, env);
      const result = await runner(planned.cmd, planned.args);
      if (result.code !== 0) {
        throw new Error(`${spec.name} upload of ${file.relPath} failed (exit ${result.code}): ${result.stderr || result.stdout}`);
      }
      return { url: spec.urlFor(file, env, result), key: file.relPath, bytes: file.bytes };
    },
  };
}
