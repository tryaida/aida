// `aida proof [--config <path>] [--walkthrough <id>] [--site-url <url>] [--json]` (decision 35):
// renders the proof sheet — a help site page, a printed page, the quick reference card and two
// video frames, side by side — into `<buildDir>/proof/` for approval at checkpoint 1. The Studio
// shows the latest one. See src/proof/index.ts.
import { loadConfig } from "../config/load.js";
import { buildProof, type ProofResult } from "../proof/index.js";
import { findConfigFile } from "./theme.js";

export interface RunProofOptions {
  config?: string;
  walkthrough?: string;
  siteUrl?: string;
  outDir?: string;
}

export async function runProof(opts: RunProofOptions, json: boolean): Promise<number> {
  let result: ProofResult;
  try {
    const configFile = opts.config ?? findConfigFile(process.cwd());
    if (!configFile) throw new Error("no aida.config.* here (or in help/) — pass --config <path>");
    const config = await loadConfig(configFile);
    result = await buildProof(config, { walkthrough: opts.walkthrough, siteUrl: opts.siteUrl, outDir: opts.outDir });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`proof failed: ${message}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return 0;
  }
  console.log(`proof sheet for ${result.walkthrough} (style: ${result.style}) -> ${result.png}`);
  for (const p of result.panels) console.log(`  ${p.label}${p.note ? ` — ${p.note}` : ""}`);
  console.log(`  open ${result.html}, or the Studio's Proof sheet, and approve the look once.`);
  return 0;
}
