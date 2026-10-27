// `aida version freeze <name>` / `aida version list` (build-plan.md M21 step 1).
import { freezeVersion, listVersions } from "../versions/index.js";

export interface RunVersionFreezeOptions {
  helpApp: string;
  name: string;
  gitRef?: string;
  force?: boolean;
}

export function runVersionFreeze(opts: RunVersionFreezeOptions, json: boolean): number {
  try {
    const result = freezeVersion({ helpApp: opts.helpApp, name: opts.name, gitRef: opts.gitRef, force: opts.force });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`froze version "${result.name}" (${result.files.length} file(s)) at ${result.dir}`);
      if (result.files.length === 0) {
        console.log("warning: no search-index.json/procedures.json/llms.txt found to snapshot — run `aida build` first");
      }
    }
    return 0;
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`version freeze failed: ${message}`);
    return 1;
  }
}

export interface RunVersionListOptions {
  helpApp: string;
}

export function runVersionList(opts: RunVersionListOptions, json: boolean): number {
  const manifest = listVersions(opts.helpApp);
  if (json) {
    console.log(JSON.stringify({ ok: true, ...manifest }));
    return 0;
  }
  if (manifest.versions.length === 0) {
    console.log("no frozen versions yet");
    return 0;
  }
  console.log(`latest: ${manifest.latest}`);
  for (const v of manifest.versions) {
    console.log(`- ${v.name}  ${v.date}${v.gitRef ? `  (${v.gitRef})` : ""}`);
  }
  return 0;
}
