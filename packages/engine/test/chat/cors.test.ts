import { describe, expect, it } from "vitest";
import { resolveCorsOrigin } from "../../src/chat/cors.js";

describe("resolveCorsOrigin", () => {
  it("allows an origin that's in the configured list", () => {
    expect(resolveCorsOrigin("https://app.example.com", ["https://app.example.com"])).toBe("https://app.example.com");
  });

  it("rejects an origin that isn't configured", () => {
    expect(resolveCorsOrigin("https://evil.example.com", ["https://app.example.com"])).toBeUndefined();
  });

  it("returns undefined for a same-origin request with no Origin header", () => {
    expect(resolveCorsOrigin(null, ["https://app.example.com"])).toBeUndefined();
  });

  it("never allows a wildcard, even with an empty allowlist", () => {
    expect(resolveCorsOrigin("https://anyone.example.com", [])).toBeUndefined();
  });
});
