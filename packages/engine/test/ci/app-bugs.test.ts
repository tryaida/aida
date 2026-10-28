// Decision 30 in `aida ci`: a failure that looks like the app misbehaving gets its own tier and
// its own heading, with its evidence and no repair command; it never sits with broken walkthroughs.
import { describe, expect, it } from "vitest";
import { buildCommentMarkdown } from "../../src/ci/comment.js";
import { tierForStatus } from "../../src/ci/tiers.js";
import type { CiResult } from "../../src/ci/types.js";

const result: CiResult = {
  base: "abc1234abc1234abc1234",
  head: "def5678def5678def5678",
  affected: ["amend-registration", "broken-one", "signed-out"],
  all: false,
  results: [
    {
      walkthrough: "amend-registration",
      status: "failed",
      tier: tierForStatus("failed", "app"),
      changedSteps: [],
      failure: {
        summary: 'step "save": locator.waitFor: Timeout 60000ms exceeded.',
        category: "app",
        reason: "suspected app bug: the save request succeeded (POST /api/registrations 200) but the screen didn't change",
        evidence: "URL /registrations/7/edit (unchanged); writes: POST /api/registrations 200; screen unchanged; signed in as admin",
      },
    },
    {
      walkthrough: "broken-one",
      status: "failed",
      tier: tierForStatus("failed", "walkthrough"),
      changedSteps: [],
      failure: { summary: 'step "open": not found', category: "walkthrough", reason: "never found", repairCommand: "claude -p repair broken-one" },
    },
    {
      walkthrough: "signed-out",
      status: "failed",
      tier: tierForStatus("failed", "environment"),
      changedSteps: [],
      failure: {
        summary: "sign-in failed (HTTP 401)",
        category: "environment",
        reason: "signing in failed, so no step ran",
        repairCommand: "claude -p repair signed-out",
      },
    },
  ],
  newRoutes: [],
  stalePages: [],
  outDir: "/tmp/out",
};

const images = { urlFor: (p: string) => p };

describe("ci: possible app bugs", () => {
  it("tiers a failed capture by its category", () => {
    expect(tierForStatus("failed", "app")).toBe("app");
    expect(tierForStatus("failed", "walkthrough")).toBe("broken");
    expect(tierForStatus("failed", "environment")).toBe("broken");
    expect(tierForStatus("failed")).toBe("broken");
    expect(tierForStatus("changed", "app")).toBe("cosmetic");
  });

  it("lists app bugs under their own heading with the evidence, and no repair command", () => {
    const md = buildCommentMarkdown(result, images, { claudeActionInstalled: true });
    expect(md).toContain("2 broken");
    expect(md).toContain("1 possible app bug(s)");
    const appSection = md.slice(md.indexOf("## Possible app bugs (not docs problems)"), md.indexOf("## Docs"));
    expect(appSection).toContain("`amend-registration` — possible app bug");
    expect(appSection).toContain("the save request succeeded (POST /api/registrations 200) but the screen didn't change");
    expect(appSection).toContain("evidence: URL /registrations/7/edit (unchanged)");
    expect(appSection).not.toContain("aida-repair");
    expect(appSection).not.toContain("@claude");
    // ... and it isn't offered to the repair skill anywhere else either.
    expect(md).not.toContain('fix the "amend-registration" walkthrough');
    expect(md.indexOf("broken-one")).toBeGreaterThan(md.indexOf("## Docs"));
  });

  it("says when a broken walkthrough looks like a setup problem", () => {
    const md = buildCommentMarkdown(result, images);
    expect(md).toContain("Looks like a setup problem, not the walkthrough: signing in failed, so no step ran.");
    expect(md).toContain("claude -p repair broken-one");
  });

  it("an undetermined failure gets no repair command, and says a person should look (M39 review)", async () => {
    const { failureSummaryFor } = await import("../../src/ci/run.js");
    const failure = failureSummaryFor("live", "aida.config.ts", "locator.waitFor: Timeout", "save", {
      step: "save",
      action: "waitFor",
      category: "undetermined",
      reason: "can't tell whether this is the walkthrough or the app",
      error: "locator.waitFor: Timeout",
      url: "",
      snapshot: "",
      screenshotPath: null,
    });
    expect(failure.repairCommand).toBeUndefined();
    const md = buildCommentMarkdown(
      { ...result, results: [{ walkthrough: "live", status: "failed", tier: tierForStatus("failed", failure.category), changedSteps: [], failure }] },
      images,
      { claudeActionInstalled: true },
    );
    expect(md).toContain("Couldn't tell whether this is the walkthrough or the app");
    expect(md).not.toContain("aida-repair");
    expect(md).not.toContain("@claude");
  });
});
