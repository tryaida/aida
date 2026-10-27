import { describe, expect, it } from "vitest";
import { DEFAULT_ALL_GLOBS, DEFAULT_IGNORE_GLOBS, matchesAnyGlob } from "../../src/impact/glob.js";

describe("matchesAnyGlob", () => {
  it("matches a simple ** pattern anywhere in the path", () => {
    expect(matchesAnyGlob("app/foo/README.md", DEFAULT_IGNORE_GLOBS)).toBe("**/*.md");
    expect(matchesAnyGlob("README.md", DEFAULT_IGNORE_GLOBS)).toBe("**/*.md");
  });

  it("does not match unrelated files", () => {
    expect(matchesAnyGlob("app/foo/page.tsx", DEFAULT_IGNORE_GLOBS)).toBeUndefined();
  });

  it("treats lockfiles, the root layout, and the auth gate as always-affects-all", () => {
    expect(matchesAnyGlob("package.json", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("pnpm-lock.yaml", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("middleware.ts", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("proxy.ts", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("app/layout.tsx", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("src/app/layout.tsx", DEFAULT_ALL_GLOBS)).toBeDefined();
    expect(matchesAnyGlob("migrations/001-init.sql", DEFAULT_ALL_GLOBS)).toBeDefined();
  });

  it("does not flag an ordinary route page, a nested layout, or a shared lib file as always-all", () => {
    expect(matchesAnyGlob("app/dashboard/teams/page.tsx", DEFAULT_ALL_GLOBS)).toBeUndefined();
    expect(matchesAnyGlob("app/dashboard/layout.tsx", DEFAULT_ALL_GLOBS)).toBeUndefined();
    expect(matchesAnyGlob("app/lib/actions/payments.ts", DEFAULT_ALL_GLOBS)).toBeUndefined();
    expect(matchesAnyGlob("components/payments/enhanced-prize-payouts.tsx", DEFAULT_ALL_GLOBS)).toBeUndefined();
  });
});
