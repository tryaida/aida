// Supabase Storage, via the Supabase CLI's `storage cp` (https://supabase.com/docs/reference/cli/supabase-storage-cp
// — verify flags before a real first use; naming and availability have shifted across CLI versions).
import { createCliBlobAdapter } from "./cli-adapter.js";
import type { BlobAdapter, StagedVideo } from "../types.js";

const ENV_VARS = ["SUPABASE_ACCESS_TOKEN", "AIDA_SUPABASE_PROJECT_REF", "AIDA_SUPABASE_BUCKET"];

export function createSupabaseStorageAdapter(env: Record<string, string | undefined> = process.env): BlobAdapter {
  return createCliBlobAdapter(
    {
      name: "supabase-storage",
      envVars: ENV_VARS,
      command: (file: StagedVideo, e) => {
        const bucket = e.AIDA_SUPABASE_BUCKET ?? "<bucket>";
        const ref = e.AIDA_SUPABASE_PROJECT_REF ?? "<project-ref>";
        return {
          cmd: "npx",
          args: ["--yes", "supabase", "storage", "cp", file.absPath, `ss://${bucket}/${file.relPath}`, "--project-ref", ref],
          description: `upload ${file.relPath} to Supabase Storage bucket "${bucket}"`,
        };
      },
      urlFor: (file: StagedVideo, e) => {
        const ref = e.AIDA_SUPABASE_PROJECT_REF ?? "<project-ref>";
        const bucket = e.AIDA_SUPABASE_BUCKET ?? "<bucket>";
        return `https://${ref}.supabase.co/storage/v1/object/public/${bucket}/${file.relPath}`;
      },
    },
    env,
  );
}
