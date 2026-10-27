import { describe, expect, it } from "vitest";
import { createFakeCommandRunner } from "../../src/publish/index.js";
import { listMergedCommits, listMergedPullRequests } from "../../src/whats-new/sources.js";

describe("listMergedCommits", () => {
  it("parses git log output into MergeEntry rows, with the PR number pulled from the subject", async () => {
    const { runner, calls } = createFakeCommandRunner({
      code: 0,
      stdout: ["abc123\x1f2026-01-02T00:00:00+00:00\x1fAdd competitor export (#42)", "def456\x1f2026-01-01T00:00:00+00:00\x1fchore: bump deps"].join("\n"),
      stderr: "",
    });
    const result = await listMergedCommits(runner, "/repo", "v1.0");
    expect(calls[0]).toMatchObject({ cmd: "git", cwd: "/repo" });
    expect(calls[0].args).toContain("v1.0..HEAD");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "abc123", prNumber: 42 });
    expect(result[1]).toMatchObject({ id: "def456", prNumber: undefined });
  });

  it("uses the whole history (HEAD) when since is omitted", async () => {
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    await listMergedCommits(runner, "/repo");
    expect(calls[0].args).toContain("HEAD");
    expect(calls[0].args.some((a) => a.includes(".."))).toBe(false);
  });

  it("throws with git's stderr on a non-zero exit", async () => {
    const { runner } = createFakeCommandRunner({ code: 128, stdout: "", stderr: "fatal: bad revision" });
    await expect(listMergedCommits(runner, "/repo", "bad-ref")).rejects.toThrow(/fatal: bad revision/);
  });
});

describe("listMergedPullRequests", () => {
  it("parses gh pr list --json output into MergeEntry rows", async () => {
    const { runner, calls } = createFakeCommandRunner({
      code: 0,
      stdout: JSON.stringify([{ number: 7, title: "Add competitor export", mergedAt: "2026-01-02T00:00:00Z", url: "https://example.com/pr/7" }]),
      stderr: "",
    });
    const result = await listMergedPullRequests(runner, "/repo");
    expect(calls[0]).toMatchObject({ cmd: "gh", cwd: "/repo" });
    expect(result).toEqual([{ id: "pr-7", subject: "Add competitor export", date: "2026-01-02T00:00:00Z", prNumber: 7, url: "https://example.com/pr/7" }]);
  });

  it("filters by since when it parses as a date, keeps everything otherwise", async () => {
    const rows = [
      { number: 1, title: "old", mergedAt: "2025-01-01T00:00:00Z" },
      { number: 2, title: "new", mergedAt: "2026-06-01T00:00:00Z" },
    ];
    const { runner } = createFakeCommandRunner({ code: 0, stdout: JSON.stringify(rows), stderr: "" });
    const filtered = await listMergedPullRequests(runner, "/repo", "2026-01-01T00:00:00Z");
    expect(filtered.map((e) => e.id)).toEqual(["pr-2"]);

    const { runner: runner2 } = createFakeCommandRunner({ code: 0, stdout: JSON.stringify(rows), stderr: "" });
    const unfiltered = await listMergedPullRequests(runner2, "/repo", "v1.0-not-a-date");
    expect(unfiltered.map((e) => e.id).sort()).toEqual(["pr-1", "pr-2"]);
  });

  it("throws when gh's output isn't valid JSON", async () => {
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "not json", stderr: "" });
    await expect(listMergedPullRequests(runner, "/repo")).rejects.toThrow(/valid JSON/);
  });
});
