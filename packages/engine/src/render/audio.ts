// Narration mix: each clip at its cue, soft ticks on clicks, loudness-normalised to -16 LUFS.
// Ported from compose.mjs lines ~196-218.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Timeline } from "./types.js";

const execFileAsync = promisify(execFile);

/** Builds `<outDir>/narration.m4a`: every narration clip at its cue, plus soft click ticks. */
export async function buildNarrationTrack(tl: Timeline, outDir: string, ffmpeg: string): Promise<string> {
  const tick = path.join(outDir, "tick.wav");
  await execFileAsync(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.6*sin(2*PI*2400*t)*exp(-t*90)+0.25*sin(2*PI*900*t)*exp(-t*60)':s=44100:d=0.06",
    "-ac",
    "1",
    tick,
  ]);

  const inputs: string[] = [];
  const filters: string[] = [];
  tl.audio.forEach((a, i) => {
    inputs.push("-i", a.file);
    const ms = Math.round(a.t * 1000);
    filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=mono,adelay=${ms}:all=1[v${i}]`);
  });
  tl.clicks.forEach((c, j) => {
    const i = tl.audio.length + j;
    inputs.push("-i", tick);
    filters.push(`[${i}:a]volume=0.22,adelay=${Math.round(c.t * 1000)}:all=1[c${j}]`);
  });
  const labels = [...tl.audio.map((_, i) => `[v${i}]`), ...tl.clicks.map((_, j) => `[c${j}]`)].join("");
  const totalInputs = tl.audio.length + tl.clicks.length;
  filters.push(
    `${labels}amix=inputs=${totalInputs}:normalize=0:dropout_transition=0,` +
      `apad,atrim=0:${tl.duration},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`,
  );

  const narrationFile = path.join(outDir, "narration.m4a");
  await execFileAsync(ffmpeg, [
    "-y",
    "-v",
    "error",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    narrationFile,
  ]);
  return narrationFile;
}
