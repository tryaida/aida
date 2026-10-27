import { describe, expect, it } from "vitest";
import { isNoiseCommit } from "../../src/whats-new/filter.js";

describe("isNoiseCommit", () => {
  it("flags conventional chore/ci/build/deps prefixes", () => {
    expect(isNoiseCommit("chore: bump deps")).toBe(true);
    expect(isNoiseCommit("ci: add workflow")).toBe(true);
    expect(isNoiseCommit("build(deps): bump lodash")).toBe(true);
    expect(isNoiseCommit("dependabot: bump foo to 2.0")).toBe(true);
    expect(isNoiseCommit("test: add missing coverage")).toBe(true);
  });

  it("keeps feat/fix and unprefixed subjects as noteworthy", () => {
    expect(isNoiseCommit("feat: add competitor export")).toBe(false);
    expect(isNoiseCommit("fix: broken login redirect")).toBe(false);
    expect(isNoiseCommit("Add a new competitors page")).toBe(false);
  });
});
