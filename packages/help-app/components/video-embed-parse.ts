// Pure parsing for `VideoEmbed` (video-embed.tsx) — no React, no `@/` imports, so it's testable
// directly under vitest's plain node environment (that alias only resolves through Next's
// bundler, not vitest's).

export interface VideoChapter {
  label: string;
  seconds: number;
  /** The step number on the page (the cue's numeric id), when the chapters file gives one. */
  step?: number;
}

function parseTimestamp(t: string): number {
  const parts = t.trim().split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Cues from a WebVTT chapters file: `00:00:05.500 --> 00:00:07.850` then the label line. */
export function parseChaptersVtt(text: string): VideoChapter[] {
  const out: VideoChapter[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    // Cue text is escaped VTT (`&amp;`, `&lt;`, `&gt;`): shown as plain text.
    const label = lines
      .slice(timing + 1)
      .join(" ")
      .trim()
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    if (!label) continue;
    const id = timing > 0 ? lines[timing - 1].trim() : "";
    out.push({ label, seconds: parseTimestamp(lines[timing].split("-->")[0]), ...(/^\d+$/.test(id) ? { step: Number(id) } : {}) });
  }
  return out;
}

export interface TranscriptBlock {
  kind: "heading" | "p";
  text: string;
}

/** A transcript Markdown file (plain prose: headings and paragraphs only — no lists, emphasis
 * or links expected) parsed into simple render blocks. `VideoEmbed` renders a "heading" block a
 * little bolder and leaves the rest as plain text. */
export function parseTranscriptMarkdown(text: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const para of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    blocks.push(heading ? { kind: "heading", text: heading[1].trim() } : { kind: "p", text: trimmed.replace(/\s+/g, " ") });
  }
  return blocks;
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** Same union as `lib/device.ts`'s `Device` — redeclared here (not imported) because that module
 * is `"use client"` and reaches into `window`/`localStorage`, which this pure-parsing file (no
 * `@/` imports — see header) must stay free of; they're structurally the same type either way. */
export type EmbedDevice = "desktop" | "phone";

/** Which devices a `VideoEmbed` offers (decision 40, M43c): just the primary device's video, or
 * both once a secondary phone video exists (`phone` prop given). Primary first, same order every
 * `DeviceSwitch` uses. */
export function devicesForEmbed(hasPhone: boolean): EmbedDevice[] {
  return hasPhone ? ["desktop", "phone"] : ["desktop"];
}

/** The media to actually show for the chosen device: the phone media once it's both chosen and
 * actually given (a device chosen before this page had a phone video, e.g. the reader's stored
 * preference from another guide, falls back to the primary rather than rendering nothing). */
export function mediaForDevice<T>(device: EmbedDevice, primary: T, phone: T | undefined): T {
  return device === "phone" && phone ? phone : primary;
}

/** The caption track's menu label for a BCP 47 tag, in that language ("English", "Deutsch"):
 * what a reader looks for in the player's captions menu. Falls back to the tag itself. */
export function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}
