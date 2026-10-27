import { describe, expect, it } from "vitest";
import { toChaptersVtt, toSrt, toVtt, wrapCaption } from "../../src/render/captions.js";
import { checkCaptions, parseSrt, parseVtt } from "../../src/qa/captions.js";
import type { TimelineCaption, TimelineChip } from "../../src/render/types.js";

const captions: TimelineCaption[] = [
  { t0: 1, t1: 3.5, text: "Here's how to add a new competitor." },
  { t0: 4, t1: 6, text: "Short line." },
];

describe("toSrt / toVtt", () => {
  it("formats SRT with index, HH:MM:SS,mmm timing and text", () => {
    const srt = toSrt(captions);
    expect(srt).toMatch(/^1\n00:00:01,000 --> 00:00:03,500\nHere's how to add a new competitor\.\n/);
    expect(srt).toContain("2\n00:00:04,000 --> 00:00:06,000\nShort line.");
  });

  it("formats WebVTT with a header and HH:MM:SS.mmm timing", () => {
    const vtt = toVtt(captions);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.500");
  });

  it("round-trips through the QA parsers", () => {
    const srtCues = parseSrt(toSrt(captions));
    const vttCues = parseVtt(toVtt(captions));
    expect(srtCues.map((c) => c.text)).toEqual(captions.map((c) => c.text));
    expect(vttCues.map((c) => c.text)).toEqual(captions.map((c) => c.text));
  });
});

describe("toChaptersVtt", () => {
  it("writes one WebVTT cue per chip, titled from the step", () => {
    const chips: TimelineChip[] = [
      { t0: 0, t1: 5, num: "1", eyebrow: "Part 1", title: "Open Competitors" },
      { t0: 5, t1: 9, num: "2", eyebrow: "Part 1", title: "Search first" },
    ];
    const vtt = toChaptersVtt(chips);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("Open Competitors");
    expect(vtt).toContain("Search first");
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
  });
});

describe("wrapCaption", () => {
  it("leaves short text alone", () => {
    const [cue] = wrapCaption({ t0: 0, t1: 2, text: "Short line." });
    expect(cue.text).toBe("Short line.");
  });

  it("wraps to <=42 chars/line, <=2 lines, without a split when it fits", () => {
    const text = "Competitors are shared across all your shows, so search first.";
    const [cue] = wrapCaption({ t0: 0, t1: 6, text });
    const lines = cue.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
    expect(lines.join(" ")).toBe(text);
  });

  it("splits into consecutive cues, proportional to text length, when text needs more than 2 lines", () => {
    // The original pipeline's single-line cue (148 chars) — too long for 2 lines at 42 chars/line.
    const text =
      "Email and phone are optional. With an email address, though, Acme Events can send them an entry confirmation, and you can email them a payment link.";
    const cues = wrapCaption({ t0: 10, t1: 18, text });
    expect(cues.length).toBeGreaterThan(1);
    // contiguous, covers the original span exactly, in order.
    expect(cues[0].t0).toBe(10);
    expect(cues[cues.length - 1].t1).toBe(18);
    for (let i = 1; i < cues.length; i++) expect(cues[i].t0).toBe(cues[i - 1].t1);
    for (const c of cues) {
      const lines = c.text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
    }
    // reassembled text matches the original (modulo the single space between chunks).
    expect(cues.map((c) => c.text.replace(/\n/g, " ")).join(" ")).toBe(text);
  });

  it("keeps reading speed within the original cue's average after splitting", () => {
    const text =
      "Email and phone are optional. With an email address, though, Acme Events can send them an entry confirmation, and you can email them a payment link.";
    const cue = { t0: 0, t1: 10, text }; // 10s, well within 20 chars/sec for ~150 chars.
    const cues = wrapCaption(cue);
    for (const c of cues) {
      const chars = c.text.replace(/\n/g, "").length;
      const cps = chars / (c.t1 - c.t0);
      expect(cps).toBeLessThanOrEqual(20);
    }
  });
});

describe("checkCaptions on generated SRT", () => {
  it("passes line-length and reading-speed checks even for the original pipeline's longest cue", () => {
    // The original pipeline's compose.mjs wrote this as one 148-char line; our generator
    // must wrap/split it to satisfy qa/captions.ts's checkCaptions (max 42 chars/line, max 2
    // lines/cue, max 20 chars/sec).
    const long: TimelineCaption = {
      t0: 0,
      t1: 8,
      text:
        "Email and phone are optional. With an email address, though, Acme Events can send them an entry confirmation, and you can email them a payment link.",
    };
    const srt = toSrt([long]);
    const cues = parseSrt(srt);
    const results = checkCaptions(cues);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
  });
});
