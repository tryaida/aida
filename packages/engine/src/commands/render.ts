import { loadWalkthroughFile } from "../walkthrough/index.js";
import { loadNarrationBeats, render, resolveArtifactBrand, type RenderResult } from "../render/index.js";
import { loadConfig } from "../config/index.js";

export interface RunRenderOptions {
  capture: string;
  voice: string;
  draft?: boolean;
  stills?: string;
  outDir?: string;
  force?: boolean;
  noCache?: boolean;
  /** Browser pages to render scenes concurrently (M10). Default `min(4, cpus/2)`. */
  concurrency?: number;
  /** aida config whose `brand` styles the video (colours, font, logo). Omitted -> neutral look. */
  configPath?: string;
}

export async function runRender(walkthroughFile: string, opts: RunRenderOptions, json: boolean): Promise<number> {
  const wf = loadWalkthroughFile(walkthroughFile);
  const narration = loadNarrationBeats(opts.voice);
  const stills = opts.stills ? opts.stills.split(",").map((s) => Number(s.trim())) : undefined;
  const outDir = opts.outDir ?? "dist/videos";

  let result: RenderResult;
  try {
    const brand = opts.configPath ? resolveArtifactBrand(await loadConfig(opts.configPath)) : undefined;
    result = await render(wf, {
      brand,
      outDir,
      captureDir: opts.capture,
      narration,
      draft: opts.draft,
      stills,
      force: opts.force,
      noCache: opts.noCache,
      concurrency: opts.concurrency,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, walkthrough: wf.walkthrough, error: message }));
    else console.error(`render failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (result.stills.length > 0) {
    console.log(`stills: ${result.stills.join(", ")}`);
  } else if (result.skipped) {
    console.log(`${result.id}: unchanged, skipped (${result.durationSec.toFixed(1)}s) -> ${result.mp4}`);
  } else {
    const scenesPart =
      result.scenesTotal !== undefined
        ? `, scenes ${result.scenesRendered}/${result.scenesTotal} rendered (${result.scenesReused} reused)`
        : "";
    console.log(
      `${result.id}: ${result.durationSec.toFixed(1)}s, ${result.frames} frames, ${(result.wallTimeMs / 1000).toFixed(1)}s wall${scenesPart} -> ${result.mp4}`,
    );
  }
  // One short clip per path (M35).
  if (!json) {
    for (const clip of result.clips ?? []) {
      if (clip.notRendered) console.log(`  path ${clip.pathId}: no clip: ${clip.notRendered}`);
      else console.log(`  path ${clip.pathId}: ${clip.skipped ? "unchanged" : `${clip.durationSec?.toFixed(1)}s`} -> ${clip.mp4}`);
    }
  }
  return 0;
}
