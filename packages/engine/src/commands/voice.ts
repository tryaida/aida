// `aida voice`: narrates one walkthrough's intro/step/outro `say` lines with
// config.voice's provider, writing a voice manifest in the shape
// render's `loadNarrationBeats` accepts (`{ results: NarrateResult[] }`).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { Walkthrough } from "../walkthrough/index.js";
import { getProvider, narrate } from "../voice/index.js";
import { DEFAULT_CACHE_DIR } from "../voice/cache.js";
import type { NarrateReport, NarrationLine } from "../voice/index.js";

export interface VoiceStageResult {
  id: string;
  manifestFile: string;
  report: NarrateReport;
  /** True when every line was a cache hit — nothing was billed/synthesized this run. */
  skipped: boolean;
}

/** Gathers the intro/step/outro `say` lines a walkthrough's narration beats come from — one per `beatIds()` id (render/timeline.ts), so a missing line never leaves render without a beat. */
export function narrationLinesOf(wf: Walkthrough): NarrationLine[] {
  const lines: NarrationLine[] = [{ id: "intro", text: wf.intro?.say ?? "" }];
  for (const step of wf.steps) {
    if (!step.id) throw new Error(`step "${step.title ?? "?"}" has no id — voice needs one per step`);
    lines.push({ id: step.id, text: step.say ?? "" });
  }
  lines.push({ id: "outro", text: wf.outro?.say ?? "" });
  return lines.map((l) => ({
    ...l,
    voice: wf.voice?.voiceId,
    speed: wf.voice?.speed,
    model: wf.voice?.model,
  }));
}

/** Narrates `wf` and writes `<outDir>/manifest.json` (an engine NarrateReport, `loadNarrationBeats`-compatible). */
export async function buildVoiceManifest(
  wf: Walkthrough,
  config: ResolvedConfig,
  outDir: string,
  opts: { force?: boolean } = {},
): Promise<VoiceStageResult> {
  const providerName = wf.voice?.provider ?? config.voice?.provider ?? "kokoro";
  const provider = getProvider(providerName);
  const lines = narrationLinesOf(wf);

  const report = await narrate(lines, provider, {
    model: config.voice?.model,
    voice: config.voice?.voiceId,
    speed: config.voice?.speed,
    pronunciation: config.voice?.pronunciation,
    force: opts.force,
    // Next to the config, not the shell's cwd: running aida from another folder must still hit
    // the cache, or a paid voice provider bills the same lines again.
    cacheDir: join(config.configDir, DEFAULT_CACHE_DIR),
  });

  mkdirSync(outDir, { recursive: true });
  const manifestFile = join(outDir, "manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(report, null, 2)}\n`);

  return {
    id: wf.walkthrough,
    manifestFile,
    report,
    skipped: report.summary.synthesized === 0,
  };
}

function resolveWalkthroughFile(walkthroughsDir: string, arg: string): string {
  if (existsSync(arg)) return arg;
  const candidates = readdirSync(walkthroughsDir).filter((f) => /\.(ya?ml)$/i.test(f));
  const match = candidates.find((f) => f === `${arg}.yaml` || f === `${arg}.yml`);
  if (!match) throw new Error(`no walkthrough found for "${arg}" in ${walkthroughsDir}`);
  return join(walkthroughsDir, match);
}

export interface RunVoiceOptions {
  configPath: string;
  force?: boolean;
}

export async function runVoiceCommand(walkthroughArg: string, opts: RunVoiceOptions, json: boolean): Promise<number> {
  const config = await loadConfig(opts.configPath);
  const file = resolveWalkthroughFile(config.walkthroughsDir, walkthroughArg);
  const wf = loadWalkthroughFile(file);
  const outDir = join(config.buildDir, wf.walkthrough, "voice");

  let result: VoiceStageResult;
  try {
    result = await buildVoiceManifest(wf, config, outDir, { force: opts.force });
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, walkthrough: wf.walkthrough, error: message }));
    else console.error(`voice failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
  } else {
    const { synthesized, cached, charsBilled } = result.report.summary;
    console.log(
      `${result.id}: ${synthesized} synthesized, ${cached} cached, ${charsBilled} chars billed -> ${result.manifestFile}`,
    );
  }
  return 0;
}
