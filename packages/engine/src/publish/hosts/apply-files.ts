// Shared `apply()` body for every host adapter: write each planned file, never overwriting one
// that's already there (same rule as `init/copy-template.ts` — a file the user has started
// editing is left alone and reported as skipped, not clobbered).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApplyFileResult, ApplyResult, PublishPlan } from "../types.js";

export function applyPlannedFiles(helpRoot: string, plan: PublishPlan): ApplyResult {
  const files: ApplyFileResult[] = [];
  for (const f of plan.files) {
    const dest = join(helpRoot, f.path);
    if (existsSync(dest)) {
      files.push({ path: f.path, action: "skipped", reason: "already exists — left untouched" });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.contents);
    files.push({ path: f.path, action: "written" });
  }
  return { files };
}
