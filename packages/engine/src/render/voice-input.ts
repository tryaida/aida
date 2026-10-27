// Loads narration beats (one per intro/step/outro) for the timeline builder. Accepts either:
//  - this engine's own voice output: a manifest with `results: NarrateResult[]`
//    (id, audioPath, durationMs — see src/voice/types.ts), or
//  - the legacy `voice/manifest.json` shape the original pipeline wrote
//    (`clips: [{id, file, duration (seconds), text, caption}]`),
//    whose `file` is relative to the manifest's own directory.
// Either way, `--voice` may point at the manifest file itself or at its containing directory.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NarrationBeat } from "./types.js";

interface LegacyClip {
  id: string;
  file: string;
  duration: number; // seconds
}

interface LegacyVoiceManifest {
  clips: LegacyClip[];
}

interface EngineNarrateResult {
  id: string;
  audioPath: string;
  durationMs: number;
}

interface EngineNarrateManifest {
  results: EngineNarrateResult[];
}

function resolveManifestPath(voiceArg: string): string {
  if (existsSync(voiceArg) && !voiceArg.endsWith(".json")) {
    const candidate = path.join(voiceArg, "manifest.json");
    if (existsSync(candidate)) return candidate;
  }
  return voiceArg;
}

/** Loads narration beats keyed by beat id (intro, each step's id, outro) from `voiceArg`. */
export function loadNarrationBeats(voiceArg: string): Record<string, NarrationBeat> {
  const manifestPath = resolveManifestPath(voiceArg);
  if (!existsSync(manifestPath)) throw new Error(`no voice manifest found at ${voiceArg}`);
  const dir = path.dirname(manifestPath);
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));

  const beats: Record<string, NarrationBeat> = {};
  if (Array.isArray(raw.results)) {
    for (const r of (raw as EngineNarrateManifest).results) {
      beats[r.id] = { audioPath: path.isAbsolute(r.audioPath) ? r.audioPath : path.resolve(dir, r.audioPath), durationMs: r.durationMs };
    }
    return beats;
  }
  if (Array.isArray(raw.clips)) {
    for (const c of (raw as LegacyVoiceManifest).clips) {
      beats[c.id] = { audioPath: path.resolve(dir, c.file), durationMs: Math.round(c.duration * 1000) };
    }
    return beats;
  }
  throw new Error(`${manifestPath} is not a recognised voice manifest (expected "results" or "clips")`);
}
