import { describe, expect, it } from "vitest";
import { buildCommentMarkdown, COMMENT_MARKER } from "../../src/ci/comment.js";
import { tierForStatus } from "../../src/ci/tiers.js";
import type { CiResult } from "../../src/ci/types.js";

const baseResult: CiResult = {
  base: "abc1234abc1234abc1234abc1234abc1234abcd",
  head: "def5678def5678def5678def5678def5678defg",
  affected: ["add-entry", "record-payment", "broken-one", "new-one"],
  all: false,
  results: [
    {
      walkthrough: "add-entry",
      status: "changed",
      tier: tierForStatus("changed"),
      changedSteps: [
        { step: "step-01.png", before: "/tmp/out/add-entry/before-step-01.png", after: "/tmp/out/add-entry/after-step-01.png", diff: "/tmp/out/add-entry/diff-step-01.png", changeRatio: 0.042 },
      ],
    },
    { walkthrough: "record-payment", status: "unchanged", tier: tierForStatus("unchanged"), changedSteps: [] },
    {
      walkthrough: "broken-one",
      status: "failed",
      tier: tierForStatus("failed"),
      changedSteps: [],
      failure: { summary: `step "submit": locator not found`, repairCommand: `claude -p "load the aida-repair skill and fix 'broken-one'"` },
    },
    { walkthrough: "new-one", status: "new", tier: tierForStatus("new"), changedSteps: [] },
  ],
  newRoutes: [
    { path: "/dashboard/sponsors", file: "app/dashboard/sponsors/page.tsx", draftCommand: `claude -p "load the aida-write skill and draft a walkthrough for the new page at /dashboard/sponsors (--config aida.config.ts); label the PR docs:new"` },
  ],
  stalePages: ["deleted-flow"],
  outDir: "/tmp/out",
};

const images = { urlFor: (p: string) => `https://raw.githubusercontent.com/acme/app/${p.split("/").slice(-2).join("/")}` };

describe("ci/comment buildCommentMarkdown", () => {
  it("includes the hidden marker for upsert lookups", () => {
    const md = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("matches the expected markdown shape", () => {
    const md = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(md).toMatchSnapshot();
  });

  it("shows the repair command for a broken walkthrough and a table for a changed one", () => {
    const md = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(md).toContain("broken-one");
    expect(md).toContain("load the aida-repair skill");
    expect(md).toContain("add-entry");
    expect(md).toContain("| step | before | after | diff | change |");
    expect(md).toContain("4.2%");
  });

  it("lists stale pages and the PR number in the footer", () => {
    const md = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(md).toContain("deleted-flow");
    expect(md).toContain("PR #42");
  });

  it("lists a new uncovered route with its draft command, and the docs:new label", () => {
    const md = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(md).toContain("/dashboard/sponsors");
    expect(md).toContain("load the aida-write skill");
    expect(md).toContain("docs:new");
  });

  it("marks a cosmetic walkthrough as needing no action, and only shows the @claude shortcut when the action is installed", () => {
    const withoutAction = buildCommentMarkdown(baseResult, images, { prNumber: 42 });
    expect(withoutAction).toContain("Cosmetic — will refresh on merge, nobody needs to do anything.");
    expect(withoutAction).not.toContain("@claude");

    const withAction = buildCommentMarkdown(baseResult, images, { prNumber: 42, claudeActionInstalled: true });
    expect(withAction).toContain("@claude load the aida-repair skill and fix the \"broken-one\" walkthrough");
    expect(withAction).toContain("@claude load the aida-write skill and draft a walkthrough for /dashboard/sponsors");
  });
});
