// `aida export playwright [walkthroughs...] --config <path> --out <dir>`: each walkthrough as a
// `@playwright/test` spec for the owner's own suite (src/export). The specs are regenerated from
// the walkthroughs, never edited.
import { relative } from "node:path";
import { exportPlaywright, type ExportPlaywrightResult } from "../export/index.js";

export interface RunExportPlaywrightOptions {
  configPath: string;
  walkthroughIds: string[];
  outDir: string;
  force?: boolean;
  json?: boolean;
}

export async function runExportPlaywright(opts: RunExportPlaywrightOptions): Promise<number> {
  let result: ExportPlaywrightResult;
  try {
    result = await exportPlaywright({ configPath: opts.configPath, walkthroughs: opts.walkthroughIds, outDir: opts.outDir, force: opts.force });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`export playwright failed: ${message}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e.walkthrough}: ${e.error}`);
    console.error("nothing written");
    return 1;
  }
  const written = result.specs.filter((s) => s.status === "written").length;
  const where = relative(process.cwd(), result.outDir) || ".";
  console.log(`exported ${result.specs.length} walkthrough(s) to ${where}: ${written} written, ${result.specs.length - written} unchanged`);
  return 0;
}
