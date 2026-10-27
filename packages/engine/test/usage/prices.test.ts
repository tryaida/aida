import { describe, expect, it } from "vitest";
import { costUsd, normalizeModelId, priceFor, voiceCostUsd, voicePricePerChar } from "../../src/usage/index.js";

describe("priceFor", () => {
  it("returns pricing for each default tier model", () => {
    expect(priceFor("claude-haiku-4-5")).toEqual({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 });
    expect(priceFor("claude-sonnet-5")).toEqual({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(priceFor("claude-opus-5-5")).toEqual({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 });
  });

  it("returns undefined for an unknown model", () => {
    expect(priceFor("not-a-real-model")).toBeUndefined();
  });

  it("prices a dotted model id the same as its hyphenated form (docs/scope.md, skills/references/tokens.md use dots)", () => {
    expect(priceFor("claude-haiku-4.5")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-opus-5.5")).toEqual(priceFor("claude-opus-5-5"));
  });

  it("prices a dated snapshot id the same as the bare id", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-haiku-4.5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
  });

  it("prices a model id case-insensitively", () => {
    expect(priceFor("Claude-Haiku-4.5")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("CLAUDE-SONNET-5")).toEqual(priceFor("claude-sonnet-5"));
  });
});

describe("normalizeModelId", () => {
  it("turns dots into hyphens, lowercases, and strips a trailing -YYYYMMDD date suffix", () => {
    expect(normalizeModelId("claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("Claude-Sonnet-4.5-20251001")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("doesn't strip a short numeric suffix that isn't an 8-digit date", () => {
    expect(normalizeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("costUsd", () => {
  it("computes cost from input/output/cacheRead tokens at the model's per-MTok rates", () => {
    const cost = costUsd({ model: "claude-sonnet-5", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 });
    expect(cost).toBeCloseTo(2 + 10 + 0.2, 6);
  });

  it("scales linearly with token counts below 1 MTok", () => {
    const cost = costUsd({ model: "claude-haiku-4-5", input: 500_000, output: 200_000, cacheRead: 0 });
    expect(cost).toBeCloseTo(0.5 * 1 + 0.2 * 5, 6);
  });

  it("is 0 for an unknown model rather than throwing", () => {
    expect(() => costUsd({ model: "mystery", input: 100, output: 100, cacheRead: 0 })).not.toThrow();
    expect(costUsd({ model: "mystery", input: 100, output: 100, cacheRead: 0 })).toBe(0);
  });

  it("is 0 for a zero-token entry", () => {
    expect(costUsd({ model: "claude-opus-5-5", input: 0, output: 0, cacheRead: 0 })).toBe(0);
  });
});

describe("voicePricePerChar / voiceCostUsd", () => {
  it("is free for kokoro and silent", () => {
    expect(voicePricePerChar("kokoro")).toBe(0);
    expect(voicePricePerChar("silent")).toBe(0);
    expect(voiceCostUsd("kokoro", 10_000)).toBe(0);
  });

  it("defaults minimax/elevenlabs to 0 until a price is configured", () => {
    expect(voicePricePerChar("minimax")).toBe(0);
    expect(voicePricePerChar("elevenlabs")).toBe(0);
  });

  it("a pricePerChar override wins over the provider default, for any provider", () => {
    expect(voicePricePerChar("minimax", 0.00003)).toBe(0.00003);
    expect(voiceCostUsd("elevenlabs", 1000, 0.0001)).toBeCloseTo(0.1, 6);
    // Overriding kokoro's (normally free) price is honoured too — config always wins.
    expect(voiceCostUsd("kokoro", 1000, 0.0001)).toBeCloseTo(0.1, 6);
  });

  it("scales linearly with characters billed", () => {
    expect(voiceCostUsd("minimax", 2000, 0.00005)).toBeCloseTo(0.1, 6);
    expect(voiceCostUsd("minimax", 4000, 0.00005)).toBeCloseTo(0.2, 6);
  });

  it("is 0 for an unknown provider rather than throwing", () => {
    expect(() => voiceCostUsd("mystery-tts", 1000)).not.toThrow();
    expect(voiceCostUsd("mystery-tts", 1000)).toBe(0);
  });
});
