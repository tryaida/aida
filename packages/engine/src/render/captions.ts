// SRT, WebVTT and WebVTT-chapters generation from the same cues, ported from compose.mjs's
// srtTime()/SRT writer (lines ~220-228) and extended to also emit VTT and a chapters track.
import type { Timeline, TimelineCaption, TimelineChip } from "./types.js";

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function vttTime(s: number): string {
  const ms = Math.round(s * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

export interface WrapOptions {
  /** Max characters per line. Default 42 — matches qa/captions.ts's checkCaptions default. */
  maxLineLength?: number;
  /** Max lines per cue. Default 2 — matches qa/captions.ts's checkCaptions default. */
  maxLines?: number;
}

function wrapWords(text: string, maxLineLength: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + " " + w).length <= maxLineLength) {
      cur += ` ${w}`;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

function chunkLines(lines: string[], maxLines: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) chunks.push(lines.slice(i, i + maxLines).join("\n"));
  return chunks;
}

/**
 * Wraps a cue's text to `maxLineLength` chars/line, `maxLines` lines/cue. When the wrapped
 * text needs more than `maxLines` lines, splits into consecutive cues — one per chunk of
 * `maxLines` lines — with the original cue's time span divided between them in proportion
 * to each chunk's character count, so reading speed (chars/sec) stays the same as the
 * original cue's average rather than spiking on any one chunk.
 */
export function wrapCaption(cue: TimelineCaption, opts: WrapOptions = {}): TimelineCaption[] {
  const maxLineLength = opts.maxLineLength ?? 42;
  const maxLines = opts.maxLines ?? 2;
  const lines = wrapWords(cue.text, maxLineLength);
  const chunks = chunkLines(lines, maxLines);
  if (chunks.length <= 1) return [{ ...cue, text: chunks[0] ?? cue.text }];

  const chunkChars = chunks.map((c) => c.replace(/\n/g, "").length);
  const totalChars = chunkChars.reduce((s, n) => s + n, 0) || chunks.length;
  const duration = cue.t1 - cue.t0;
  let t = cue.t0;
  return chunks.map((text, i) => {
    const t0 = t;
    const isLast = i === chunks.length - 1;
    const share = (chunkChars[i] / totalChars) * duration;
    const t1 = isLast ? cue.t1 : t0 + share;
    t = t1;
    return { t0, t1, text };
  });
}

/** Wraps and (where needed) splits every caption cue, in order. */
export function wrapCaptions(captions: TimelineCaption[], opts: WrapOptions = {}): TimelineCaption[] {
  return captions.flatMap((c) => wrapCaption(c, opts));
}

/** SRT captions from the timeline's caption cues, wrapped/split to fit subtitle line limits. */
export function toSrt(captions: TimelineCaption[], opts: WrapOptions = {}): string {
  const cues = wrapCaptions(captions, opts);
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.t0)} --> ${srtTime(c.t1)}\n${c.text}\n`).join("\n");
}

/** WebVTT captions from the same cues, wrapped/split to fit subtitle line limits. */
export function toVtt(captions: TimelineCaption[], opts: WrapOptions = {}): string {
  const wrapped = wrapCaptions(captions, opts);
  const cues = wrapped.map((c, i) => `${i + 1}\n${vttTime(c.t0)} --> ${vttTime(c.t1)}\n${c.text}\n`).join("\n");
  return `WEBVTT\n\n${cues}`;
}

/** WebVTT chapters track, one cue per step (the timeline's chips). */
export function toChaptersVtt(chips: TimelineChip[]): string {
  const cues = chips
    .map((c, i) => `${i + 1}\n${vttTime(c.t0)} --> ${vttTime(c.t1)}\n${c.title}\n`)
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

export function captionsFor(tl: Timeline): { srt: string; vtt: string; chaptersVtt: string } {
  return { srt: toSrt(tl.captions), vtt: toVtt(tl.captions), chaptersVtt: toChaptersVtt(tl.chips) };
}
