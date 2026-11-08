import { describe, expect, it } from "vitest";
import { devicesForEmbed, languageLabel, mediaForDevice, parseChaptersVtt, parseTranscriptMarkdown } from "../../components/video-embed-parse";

describe("parseChaptersVtt", () => {
  it("reads cue timing and label, unescaping VTT entities", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:05.500",
      "Open Payments",
      "",
      "2",
      "00:00:05.500 --> 00:00:12.000",
      "Add a card &amp; save",
    ].join("\n");
    expect(parseChaptersVtt(vtt)).toEqual([
      { label: "Open Payments", seconds: 0, step: 1 },
      { label: "Add a card & save", seconds: 5.5, step: 2 },
    ]);
  });

  it("parses an hour:minute:second timestamp", () => {
    const vtt = "1\n01:02:03.000 --> 01:02:10.000\nLater";
    expect(parseChaptersVtt(vtt)[0].seconds).toBe(60 * 60 + 2 * 60 + 3);
  });

  it("skips a block with no cue text", () => {
    const vtt = "1\n00:00:00.000 --> 00:00:01.000\n";
    expect(parseChaptersVtt(vtt)).toEqual([]);
  });

  it("returns nothing for text with no timing line", () => {
    expect(parseChaptersVtt("WEBVTT\n\njust a note")).toEqual([]);
  });
});

describe("parseTranscriptMarkdown", () => {
  it("splits headings and paragraphs, stripping the heading marker", () => {
    expect(parseTranscriptMarkdown("# Open Payments\n\nClick Add, then Save.\n\n## Add a card\n\nEnter the card number.")).toEqual([
      { kind: "heading", text: "Open Payments" },
      { kind: "p", text: "Click Add, then Save." },
      { kind: "heading", text: "Add a card" },
      { kind: "p", text: "Enter the card number." },
    ]);
  });

  it("collapses internal whitespace in a paragraph (a wrapped transcript line)", () => {
    expect(parseTranscriptMarkdown("This line\nwraps   across\nthree lines.")).toEqual([{ kind: "p", text: "This line wraps across three lines." }]);
  });

  it("drops blank paragraphs", () => {
    expect(parseTranscriptMarkdown("First.\n\n\n\nSecond.")).toEqual([
      { kind: "p", text: "First." },
      { kind: "p", text: "Second." },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parseTranscriptMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("devicesForEmbed (decision 40, M43c)", () => {
  it("offers just the primary device with no phone video", () => {
    expect(devicesForEmbed(false)).toEqual(["desktop"]);
  });

  it("offers desktop then phone once a secondary phone video exists", () => {
    expect(devicesForEmbed(true)).toEqual(["desktop", "phone"]);
  });
});

describe("mediaForDevice (decision 40, M43c)", () => {
  const primary = { src: "/videos/x/x.mp4" };
  const phone = { src: "/videos/x/x.phone.mp4" };

  it("shows the primary device's media by default", () => {
    expect(mediaForDevice("desktop", primary, phone)).toBe(primary);
  });

  it("shows the phone media once phone is chosen and it exists", () => {
    expect(mediaForDevice("phone", primary, phone)).toBe(phone);
  });

  it("falls back to the primary media when phone is chosen but there is none (a stored preference from another guide)", () => {
    expect(mediaForDevice("phone", primary, undefined)).toBe(primary);
  });
});

describe("languageLabel", () => {
  it("names the caption language in itself, falling back to the tag", () => {
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("de")).toBe("Deutsch");
    expect(languageLabel("not a tag")).toBe("not a tag");
  });
});

describe("parseChaptersVtt step numbers", () => {
  it("reads each cue's numeric id as the page's step number", () => {
    const vtt = "WEBVTT\n\n1\n00:00:07.500 --> 00:00:17.500\nMark the dates\n\n3\n00:00:17.500 --> 00:00:20.950\nContinue\n";
    expect(parseChaptersVtt(vtt).map((c) => c.step)).toEqual([1, 3]);
  });
});
