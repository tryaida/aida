import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { voiceFitFor, voiceFitForConfig } from "../../src/voice/fit.js";

describe("voice fit from the app brief (M34)", () => {
  it("keeps Kokoro's default for professional audiences", () => {
    expect(voiceFitFor("Office staff who record payments and follow up unpaid orders for customers.")).toBeUndefined();
  });

  it("maps audiences to a voice and pace, deterministically", () => {
    expect(voiceFitFor("Parents and students checking the timetable")).toMatchObject({ voice: "af_bella", speed: 1 });
    expect(voiceFitFor("Volunteers, many first-time users")).toMatchObject({ speed: 0.92 });
    expect(voiceFitFor("Developers and DevOps engineers")).toMatchObject({ voice: "am_michael", speed: 1.05 });
  });

  it("reads the brief's Who uses it, and never overrides the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-voice-fit-"));
    writeFileSync(join(dir, "app-brief.md"), "# Acme\n\n## What it's for\nBooking classes.\n\n## Who uses it\nParents booking swimming lessons for their children.\n");
    expect(voiceFitForConfig({ configDir: dir })).toMatchObject({ voice: "af_bella" });
    expect(voiceFitForConfig({ configDir: dir, voice: { voiceId: "bf_emma" } })).toBeUndefined();
    expect(voiceFitForConfig({ configDir: dir, voice: { speed: 1.1 } })).toBeUndefined();
    expect(voiceFitForConfig({ configDir: dir, voice: { provider: "elevenlabs" } })).toBeUndefined();
    expect(voiceFitForConfig({ configDir: mkdtempSync(join(tmpdir(), "aida-voice-fit-")) })).toBeUndefined();
  });
});
