// Decision 40 (M43 review finding 6): a device-filtered walkthrough's video numbers its steps by
// their place in the whole walkthrough, as the page, PDF and screenshot badges do.
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../../src/render/timeline.js";
import { buildTranscript } from "../../src/render/transcript.js";
import { toChaptersVtt } from "../../src/render/captions.js";
import type { CaptureManifest } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

/** The phone's view of a three-step walkthrough whose step 2 is desktop-only. */
function filtered(): Walkthrough {
  return {
    walkthrough: "demo",
    title: "Demo walkthrough",
    steps: [
      { id: "open", title: "Open the form", say: "Open the form.", camera: "full", actions: [] },
      { id: "save", title: "Save it", say: "Save it.", camera: "full", actions: [] },
    ],
  };
}

function manifest(): CaptureManifest {
  const step = (id: string, image: string) => ({
    id,
    camera: "full" as const,
    cameraBox: null,
    events: [{ type: "frame" as const, image, transition: "cut" as const }],
    doc: { image, highlights: [] },
    impact: { urls: [], requests: [] },
    checks: [],
  });
  return {
    workflow: "demo",
    capturedAt: "2026-11-08T00:00:00.000Z",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    steps: [step("open", "0001-a.png"), step("save", "0002-b.png")],
  };
}

const narration = {
  intro: { audioPath: "/voice/intro.wav", durationMs: 1000 },
  open: { audioPath: "/voice/open.wav", durationMs: 1000 },
  save: { audioPath: "/voice/save.wav", durationMs: 1000 },
  outro: { audioPath: "/voice/outro.wav", durationMs: 1000 },
};

describe("whole-walkthrough step numbering", () => {
  it("numbers chips, highlight badges and transcript headings by the whole walkthrough's positions", () => {
    const stepNumbering = { numbers: [1, 3], total: 3 };
    const tl = buildTimeline(filtered(), manifest(), narration, { fps: 30, stepNumbering });
    expect(tl.chips.map((c) => [c.num, c.eyebrow])).toEqual([
      ["1", "Step 1 of 3"],
      ["3", "Step 3 of 3"],
    ]);
    // Chapter cues carry the step titles only (their cue ids are sequence numbers, not steps).
    expect(toChaptersVtt(tl.chips)).toContain("Save it");
    const text = buildTranscript(filtered(), stepNumbering);
    expect(text).toContain("## 1. Open the form");
    expect(text).toContain("## 3. Save it");
    expect(text).not.toContain("## 2.");
  });

  it("is byte-identical to no numbering when the numbering is the identity", () => {
    const identity = { numbers: [1, 2], total: 2 };
    const plain = buildTimeline(filtered(), manifest(), narration, { fps: 30 });
    const numbered = buildTimeline(filtered(), manifest(), narration, { fps: 30, stepNumbering: identity });
    expect(JSON.stringify(numbered)).toBe(JSON.stringify(plain));
    expect(buildTranscript(filtered(), identity)).toBe(buildTranscript(filtered()));
  });
});
