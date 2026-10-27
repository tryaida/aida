import { describe, expect, it } from "vitest";
import { CaptureRunTracker, planCaptureRun, type PlanInput } from "../../src/states/order.js";

const w = (id: string, f: Omit<PlanInput, "walkthrough"> = {}): PlanInput => ({ walkthrough: id, ...f });
const ids = (plan: { walkthroughs: { id: string }[] }): string[] => plan.walkthroughs.map((p) => p.id);
const dbCheck = { database: [{}] };

describe("planCaptureRun ordering", () => {
  it("keeps input order when nothing depends on anything", () => {
    const all = [w("c"), w("a"), w("b")];
    const plan = planCaptureRun(all, all, {});
    expect(plan.problems).toEqual([]);
    expect(ids(plan)).toEqual(["c", "a", "b"]);
  });

  it("puts providers before the walkthroughs that need them, through a chain", () => {
    const overbook = w("overbook", { needs: ["session-full"] });
    const fill = w("fill-session", { needs: ["session-exists"], leaves: ["session-full"] });
    const add = w("add-session", { leaves: ["session-exists"] });
    const all = [overbook, fill, add];
    const plan = planCaptureRun(all, all, {});
    expect(plan.problems).toEqual([]);
    expect(ids(plan)).toEqual(["add-session", "fill-session", "overbook"]);
    expect(plan.walkthroughs[2].needs).toEqual([{ state: "session-full", metBy: "walkthrough", providers: ["fill-session"] }]);
  });

  it("runs a needer before anything that clears what it needs", () => {
    // The outside run: an earlier capture took Alex out of the morning block before
    // "change your registration" (which needs Alex in it) ran.
    const remove = w("leave-morning-block", { clears: ["alex-in-morning"] });
    const register = w("register-alex", { leaves: ["alex-in-morning"] });
    const change = w("change-registration", { needs: ["alex-in-morning"] });
    const all = [remove, register, change];
    const plan = planCaptureRun(all, all, {});
    expect(ids(plan)).toEqual(["register-alex", "change-registration", "leave-morning-block"]);
  });

  it("runs a dependency chain together, where its first member was listed", () => {
    const all = [w("p", { leaves: ["x"] }), w("unrelated"), w("c", { needs: ["x"] }), w("last")];
    expect(ids(planCaptureRun(all, all, {}))).toEqual(["p", "c", "unrelated", "last"]);
  });

  it("breaks ties by input order, deterministically", () => {
    const all = [w("b", { needs: ["x"] }), w("a", { needs: ["x"] }), w("p", { leaves: ["x"] })];
    const first = ids(planCaptureRun(all, all, {}));
    expect(first).toEqual(["p", "b", "a"]);
    expect(ids(planCaptureRun(all, all, {}))).toEqual(first);
  });

  it("adds no edge for a need met by a config setup hook", () => {
    const all = [w("needer", { needs: ["x"] }), w("provider", { leaves: ["x"] })];
    const plan = planCaptureRun(all, all, { states: { x: { setup: () => {} } } });
    expect(ids(plan)).toEqual(["needer", "provider"]);
    expect(plan.walkthroughs[0].needs[0]).toEqual({ state: "x", metBy: "hook", providers: [] });
  });

  it("meets a check-only need with nothing leaving it by the check at run time", () => {
    const all = [w("needer", { needs: ["seeded"] })];
    const plan = planCaptureRun(all, all, { states: { seeded: { check: () => true } } });
    expect(plan.problems).toEqual([]);
    expect(plan.walkthroughs[0].needs[0].metBy).toBe("check");
  });
});

describe("planCaptureRun problems", () => {
  it("names the state and the candidate providers when a provider isn't in the run", () => {
    const needer = w("remove-from-waitlist", { needs: ["alex-on-waitlist"] });
    const all = [needer, w("join-waitlist", { leaves: ["alex-on-waitlist"] })];
    const plan = planCaptureRun([needer], all, {});
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatchObject({ kind: "missing-provider", state: "alex-on-waitlist", candidates: ["join-waitlist"] });
    expect(plan.problems[0].message).toContain("join-waitlist");
    expect(plan.problems[0].message).toContain("--with-deps");
  });

  it("says when nothing at all leaves a needed state", () => {
    const needer = w("needer", { needs: ["ghost"] });
    const plan = planCaptureRun([needer], [needer], { states: { ghost: { description: "nothing" } } });
    expect(plan.problems[0].message).toContain("no walkthrough leaves it");
  });

  it("reports a cycle and prints it", () => {
    const all = [w("a", { needs: ["y"], leaves: ["x"] }), w("b", { needs: ["x"], leaves: ["y"] }), w("c")];
    const plan = planCaptureRun(all, all, {});
    // The rest of the run is still planned; the cycle's members are blocked and last.
    expect(ids(plan)).toEqual(["c", "a", "b"]);
    expect(plan.walkthroughs.map((p) => Boolean(p.blocked))).toEqual([false, true, true]);
    const cycle = plan.problems.find((p) => p.kind === "cycle")!;
    expect(new Set(cycle.walkthroughs)).toEqual(new Set(["a", "b"]));
    expect(cycle.message).toContain("a needs y, which b leaves");
    expect(cycle.message).toContain("b needs x, which a leaves");
  });

  it("says when a walkthrough both needs and leaves a state nothing else leaves", () => {
    const again = w("add-another", { needs: ["session-exists"], leaves: ["session-exists"] });
    const plan = planCaptureRun([again], [again], {});
    expect(plan.problems[0].message).toContain("add-another both needs and leaves session-exists");
    expect(plan.walkthroughs[0].blocked).toContain("both needs and leaves");
  });

  it("blocks only the walkthrough with an unmet need; the rest still run, with their resets", () => {
    const all = [w("needer", { needs: ["ghost"] }), w("other", { validate: dbCheck })];
    const plan = planCaptureRun(all, all, {}, { reset: "every" });
    expect(ids(plan)).toEqual(["needer", "other"]);
    expect(plan.walkthroughs[0]).toMatchObject({ blocked: expect.stringContaining("needer needs ghost"), resetBefore: false });
    expect(plan.walkthroughs[1]).toMatchObject({ resetBefore: true });
    expect(plan.walkthroughs[1].blocked).toBeUndefined();
  });

  it("reports a cycle made by a clear", () => {
    // n needs x and z; k leaves z (so runs first) but clears x (so must run after n).
    const all = [w("p", { leaves: ["x"] }), w("k", { clears: ["x"], leaves: ["z"] }), w("n", { needs: ["x", "z"] })];
    const problem = planCaptureRun(all, all, {}).problems[0];
    expect(problem.kind).toBe("cycle");
    expect(problem.message).toContain("k clears x, which n needs");
  });
});

describe("planCaptureRun --with-deps", () => {
  it("pulls providers in transitively and says why", () => {
    const overbook = w("overbook", { needs: ["session-full"] });
    const fill = w("fill-session", { needs: ["session-exists"], leaves: ["session-full"] });
    const add = w("add-session", { leaves: ["session-exists"] });
    const all = [add, fill, overbook, w("unrelated")];
    const plan = planCaptureRun([overbook], all, {}, { withDeps: true });
    expect(plan.problems).toEqual([]);
    expect(ids(plan)).toEqual(["add-session", "fill-session", "overbook"]);
    expect(plan.walkthroughs[0]).toMatchObject({ reason: "dependency", pulledInFor: [{ walkthrough: "fill-session", state: "session-exists" }] });
    expect(plan.walkthroughs[2].reason).toBe("selected");
  });

  it("prefers a provider that doesn't clear the needer's other needs, whatever the file order", () => {
    // reset-session leaves session-exists but clears seat-held, which book-seat also needs.
    const book = w("book-seat", { needs: ["session-exists", "seat-held"] });
    const bad = w("reset-session", { leaves: ["session-exists"], clears: ["seat-held"] });
    const good = w("add-session", { leaves: ["session-exists"] });
    const hold = w("hold-seat", { leaves: ["seat-held"] });
    const plan = planCaptureRun([book], [bad, good, hold, book], {}, { withDeps: true });
    expect(plan.problems).toEqual([]);
    expect(ids(plan)).toEqual(["add-session", "hold-seat", "book-seat"]);
  });

  it("falls back to the first provider, and reports the cycle, only when none works", () => {
    const book = w("book-seat", { needs: ["session-exists", "seat-held"] });
    const bad = w("reset-session", { leaves: ["session-exists"], clears: ["seat-held"] });
    const plan = planCaptureRun([book], [bad, w("hold-seat", { leaves: ["seat-held"] }), book], {}, { withDeps: true });
    expect(plan.walkthroughs.find((p) => p.id === "reset-session")?.reason).toBe("dependency");
    expect(plan.problems.map((p) => p.kind)).toEqual(["cycle"]);
  });

  it("doesn't pull in a provider for a need with a setup hook", () => {
    const needer = w("needer", { needs: ["x"] });
    const plan = planCaptureRun([needer], [needer, w("p", { leaves: ["x"] })], { states: { x: { setup: () => {} } } }, { withDeps: true });
    expect(ids(plan)).toEqual(["needer"]);
  });
});

describe("planCaptureRun resets", () => {
  it("database-checks: resets only before walkthroughs with database checks when nothing depends on anything", () => {
    const all = [w("a"), w("b", { validate: dbCheck }), w("c")];
    const plan = planCaptureRun(all, all, {}, { reset: "database-checks" });
    expect(plan.walkthroughs.map((p) => p.resetBefore)).toEqual([false, true, false]);
  });

  it("database-checks: moves a chain member's reset to the start of its chain", () => {
    const all = [w("p", { leaves: ["x"] }), w("c", { needs: ["x"], validate: dbCheck })];
    const plan = planCaptureRun(all, all, {}, { reset: "database-checks" });
    expect(plan.walkthroughs.map((p) => p.resetBefore)).toEqual([true, false]);
    expect(plan.walkthroughs[0].resetNote).toContain("start of its chain");
    expect(plan.walkthroughs[1].resetNote).toContain("keeps the data p left");
  });

  it("every (CI): resets before every walkthrough except inside a chain", () => {
    const all = [w("a"), w("p", { leaves: ["x"] }), w("mid", { needs: ["x"], leaves: ["y"] }), w("c", { needs: ["y"] }), w("z")];
    const plan = planCaptureRun(all, all, {}, { reset: "every" });
    expect(ids(plan)).toEqual(["a", "p", "mid", "c", "z"]);
    expect(plan.walkthroughs.map((p) => p.resetBefore)).toEqual([true, true, false, false, true]);
  });

  it("every (CI): an unrelated walkthrough listed between a provider and its needer keeps its reset", () => {
    const all = [w("p", { leaves: ["x"] }), w("other"), w("c", { needs: ["x"] })];
    const plan = planCaptureRun(all, all, {}, { reset: "every" });
    expect(ids(plan)).toEqual(["p", "c", "other"]);
    expect(plan.walkthroughs.map((p) => p.resetBefore)).toEqual([true, false, true]);
  });

  it("never resets between a provider and its consumer, even when a clear interleaves chains", () => {
    // q's chain is ordered after n (n needs x, q clears x) but q's provider rule keeps r first.
    const all = [w("p", { leaves: ["x"] }), w("n", { needs: ["x"] }), w("q", { clears: ["x"], leaves: ["y"] }), w("r", { needs: ["y"] })];
    const plan = planCaptureRun(all, all, {}, { reset: "every" });
    const order = ids(plan);
    const pos = (id: string): number => order.indexOf(id);
    for (const [provider, consumer] of [["p", "n"], ["q", "r"]]) {
      for (let i = pos(provider) + 1; i <= pos(consumer); i++) expect(plan.walkthroughs[i].resetBefore).toBe(false);
    }
  });

  it("none: never resets", () => {
    const all = [w("a", { validate: dbCheck })];
    expect(planCaptureRun(all, all, {}, { reset: "none" }).walkthroughs[0].resetBefore).toBe(false);
  });
});

describe("CaptureRunTracker", () => {
  it("skips a walkthrough whose provider failed, and its dependants in turn", () => {
    const all = [w("p", { leaves: ["x"] }), w("c", { needs: ["x"], leaves: ["y"] }), w("d", { needs: ["y"] })];
    const plan = planCaptureRun(all, all, {});
    const tracker = new CaptureRunTracker();
    tracker.record("p", false);
    expect(tracker.skipReason(plan.walkthroughs[1])).toBe("skipped: needs x, which p didn't leave");
    tracker.record("c", false);
    expect(tracker.skipReason(plan.walkthroughs[2])).toBe("skipped: needs y, which c didn't leave");
  });

  it("passes a provider's possible app bug on to its dependants, and blocks plan problems", () => {
    const all = [w("p", { leaves: ["x"] }), w("c", { needs: ["x"], leaves: ["y"] }), w("d", { needs: ["y"] })];
    const plan = planCaptureRun(all, all, {});
    const tracker = new CaptureRunTracker();
    tracker.record("p", false, { category: "app" });
    const c = tracker.blocked(plan.walkthroughs[1])!;
    expect(c).toEqual({ reason: "skipped: needs x, which p didn't leave", providers: ["p"], appBugIn: ["p"] });
    tracker.record("c", false, { appBugIn: c.appBugIn });
    expect(tracker.blocked(plan.walkthroughs[2])?.appBugIn).toEqual(["p"]);
    // A walkthrough failure doesn't make it an app bug.
    tracker.record("p", false, { category: "walkthrough" });
    expect(tracker.blocked(plan.walkthroughs[1])?.appBugIn).toEqual([]);
    expect(tracker.blocked({ needs: [], blocked: "no order works" })?.reason).toBe("blocked: no order works");
  });

  it("lets it run when a provider succeeded", () => {
    const all = [w("p", { leaves: ["x"] }), w("c", { needs: ["x"] })];
    const plan = planCaptureRun(all, all, {});
    const tracker = new CaptureRunTracker();
    tracker.record("p", true);
    expect(tracker.skipReason(plan.walkthroughs[1])).toBeUndefined();
  });
});
