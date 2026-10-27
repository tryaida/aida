// A `BlobAdapter` that never runs a command or touches the network — the default for
// `--dry-run` and for every test. Returns a deterministic, obviously-fake URL so a rewritten
// page's frontmatter is still inspectable without needing real credentials.
import type { BlobAdapter, PlannedCommand, StagedVideo } from "../types.js";

export function createDryRunBlobAdapter(): BlobAdapter {
  return {
    name: "vercel-blob",
    envVars: [],
    plan(file: StagedVideo): PlannedCommand[] {
      return [
        {
          cmd: "true",
          args: [],
          description: `(dry run) would upload ${file.relPath} (${file.bytes} bytes) to blob storage`,
        },
      ];
    },
    async upload(file: StagedVideo) {
      return {
        url: `https://dry-run.blob.local/${encodeURIComponent(file.relPath)}`,
        key: file.relPath,
        bytes: file.bytes,
      };
    },
  };
}
