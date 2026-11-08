import { describe, expect, it } from "vitest";
import { DEFAULT_LANG, resolveLang } from "../../lib/brand";

describe("resolveLang", () => {
  it("keeps a configured BCP 47 tag, trimmed", () => {
    expect(resolveLang(" en-GB ")).toBe("en-GB");
  });

  it("falls back to DEFAULT_LANG when unset, empty, or blank", () => {
    expect(resolveLang(undefined)).toBe(DEFAULT_LANG);
    expect(resolveLang("")).toBe(DEFAULT_LANG);
    expect(resolveLang("   ")).toBe(DEFAULT_LANG);
  });
});
