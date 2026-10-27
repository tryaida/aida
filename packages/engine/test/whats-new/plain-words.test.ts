import { describe, expect, it } from "vitest";
import { toPlainWords } from "../../src/whats-new/plain-words.js";

describe("toPlainWords", () => {
  it("strips a conventional-commit prefix and capitalises", () => {
    expect(toPlainWords("feat: add competitor export")).toBe("Add competitor export");
    expect(toPlainWords("fix(auth): broken login redirect")).toBe("Broken login redirect");
  });

  it("strips a trailing squash-merge PR number suffix", () => {
    expect(toPlainWords("feat: add competitor export (#123)")).toBe("Add competitor export");
  });

  it("leaves an unprefixed subject alone apart from capitalisation", () => {
    expect(toPlainWords("add a new competitors page")).toBe("Add a new competitors page");
  });

  it("falls back to the original subject (capitalised) if stripping empties it", () => {
    expect(toPlainWords("chore:")).toBe("Chore:");
  });
});
