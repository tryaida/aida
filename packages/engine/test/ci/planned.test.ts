// The planned CI capture loop (ci/planned.ts) and how `aida ci` reports a walkthrough blocked by
// a failed provider (ci/run.ts): no repair command pointing at a failure.json that isn't there or
// is from an earlier run, the provider named, and a provider's possible app bug passed on.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { FailureReport } from "../../src/capture/types.js";
import { runIdFor } from "../../src/states/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.doUnmock("../../src/ci/capture.js");
});

function project(walkthroughs: Record<string, string>): { dir: string; buildDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aida-ci-planned-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  for (const [id, extra] of Object.entries(walkthroughs)) {
    writeFileSync(join(dir, "walkthroughs", `${id}.yaml`), [`walkthrough: ${id}`, `title: "${id}"`, extra, "steps:", "  - id: only-step", '    title: "Do"'].join("\n"));
  }
  return { dir, buildDir: join(dir, ".build") };
}

async function runPlanned(failCategory: FailureReport["category"], database?: ResolvedConfig["database"], mainOk?: boolean) {
  vi.resetModules();
  const { dir, buildDir } = project({ "add-session": "leaves: [session-exists]", overbook: "needs: [session-exists]\nleaves: [session-full]", "waitlist-full": "needs: [session-full]" });
  // A stale failure.json from an earlier run, for a walkthrough that will be blocked.
  const stale = join(buildDir, "overbook", "ci", "capture");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "failure.json"), JSON.stringify({ error: "from an earlier run" }));
  writeFileSync(join(stale, "validation.json"), JSON.stringify({ ok: true }));
  const runIds: (string | undefined)[] = [];
  vi.doMock("../../src/ci/capture.js", () => ({
    captureWalkthroughForCi: vi.fn(async (file: string, _c: unknown, _u: unknown, planned: { runId?: string }) => {
      runIds.push(planned.runId);
      const id = file.split("/").pop()!.replace(".yaml", "");
      const failure = { error: "save didn't show", category: failCategory, reason: "the save request succeeded but the screen didn't change" } as FailureReport;
      return { walkthrough: { walkthrough: id }, captureDir: join(buildDir, id, "ci", "capture"), ok: false, ...(mainOk !== undefined ? { mainOk } : {}), failure };
    }),
  }));
  const { captureInPlannedOrder } = await import("../../src/ci/planned.js");
  const config = { app: { baseUrl: "http://localhost:3000" }, configDir: dir, walkthroughsDir: join(dir, "walkthroughs"), outDir: dir, buildDir, ...(database ? { database } : {}) } as ResolvedConfig;
  const entries = ["add-session", "overbook", "waitlist-full"].map((id) => ({ id, file: join(dir, "walkthroughs", `${id}.yaml`) }));
  const outcomes = [];
  for await (const o of captureInPlannedOrder(config, entries as never, ["waitlist-full"], undefined)) outcomes.push(o);
  return { outcomes, stale, runIds };
}

describe("captureInPlannedOrder: a provider fails", () => {
  it("blocks its dependants, names the provider, and clears their stale capture files", async () => {
    const { outcomes, stale } = await runPlanned("walkthrough");
    expect(outcomes.map((o) => o.id)).toEqual(["add-session", "overbook", "waitlist-full"]);
    expect(outcomes[1]).toMatchObject({ blocked: "skipped: needs session-exists, which add-session didn't leave", blockedBy: ["add-session"], appBugIn: [] });
    expect(outcomes[2]).toMatchObject({ blockedBy: ["overbook"], appBugIn: [] });
    expect(existsSync(join(stale, "failure.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(stale, "validation.json"), "utf8"))).toMatchObject({ ok: false, notCaptured: outcomes[1].blocked });
  });

  it("doesn't block dependants when only a path failed (the main run passed), as aida capture does", async () => {
    const { outcomes } = await runPlanned("walkthrough", undefined, true);
    expect(outcomes.map((o) => ("blocked" in o && o.blocked ? "blocked" : "captured"))).toEqual(["captured", "captured", "captured"]);
  });

  it("passes a provider's possible app bug down the chain", async () => {
    const { outcomes } = await runPlanned("app");
    expect(outcomes[1]).toMatchObject({ appBugIn: ["add-session"] });
    expect(outcomes[2]).toMatchObject({ appBugIn: ["add-session"] });
  });

  it("uses a fixed run id under CI when the database adapter can reset", async () => {
    const prev = process.env.AIDA_RUN_ID;
    delete process.env.AIDA_RUN_ID;
    try {
      const { runIds } = await runPlanned("walkthrough", { url: async () => "postgres://127.0.0.1/x", reset: async () => {} } as never);
      expect(runIds).toEqual(["ci"]);
    } finally {
      if (prev !== undefined) process.env.AIDA_RUN_ID = prev;
    }
  });
});

describe("blockedFailureSummary (aida ci)", () => {
  it("has no repair command, names the provider, and inherits the app tier", async () => {
    const { blockedFailureSummary } = await import("../../src/ci/run.js");
    const { tierForStatus } = await import("../../src/ci/tiers.js");
    const plain = blockedFailureSummary({ blocked: "skipped: needs x, which p didn't leave", blockedBy: ["p"], appBugIn: [] });
    expect(plain).toEqual({ summary: "skipped: needs x, which p didn't leave", blockedBy: ["p"] });
    expect(tierForStatus("failed", plain.category)).toBe("broken");

    const app = blockedFailureSummary({ blocked: "skipped: needs x, which p didn't leave", blockedBy: ["p"], appBugIn: ["p"] });
    expect(app.repairCommand).toBeUndefined();
    expect(app).toMatchObject({ category: "app", reason: "blocked by a possible app bug in p" });
    expect(tierForStatus("failed", app.category)).toBe("app");
  });
});

describe("runIdFor", () => {
  it("is fixed under CI with a reset adapter, random otherwise, and AIDA_RUN_ID always wins", () => {
    expect(runIdFor({ ci: true, canReset: true }, {})).toBe("ci");
    expect(runIdFor({ ci: true, canReset: false }, {})).not.toBe("ci");
    expect(runIdFor({}, {})).not.toBe(runIdFor({}, {}));
    expect(runIdFor({ ci: true, canReset: true }, { AIDA_RUN_ID: "mine" })).toBe("mine");
  });
});
