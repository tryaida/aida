import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/chat/rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to perMinute requests per client, then blocks", () => {
    const limiter = new RateLimiter(2);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("tracks separate clients independently", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(false);
  });

  it("resets a client's budget once its window has elapsed", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    now += 60_001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("evicts expired per-client buckets instead of growing the map forever (review finding rate-limit.ts:10: 'Map never pruned')", () => {
    let now = 0;
    const limiter = new RateLimiter(5, () => now);
    for (let i = 0; i < 50; i++) limiter.allow(`client-${i}`);
    expect(limiter.size).toBe(50);
    now += 60_001;
    // One more call triggers the expiry sweep; all 50 stale buckets should be gone, leaving
    // only the fresh one this call creates.
    limiter.allow("client-fresh");
    expect(limiter.size).toBe(1);
  });

  it("caps total buckets held, refusing new clients once full even if not yet expired", () => {
    const limiter = new RateLimiter(5, Date.now, Infinity, 2);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(false);
    // Existing clients already tracked still get to use their own budget.
    expect(limiter.allow("a")).toBe(true);
  });

  it("enforces a global per-minute cap across all clients, independent of any one client's own budget (review finding route.ts:56: 'add a global per-minute cap too')", () => {
    const limiter = new RateLimiter(100, Date.now, 3);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(true);
    // Each client is well under its own 100/min budget, but the shared global budget is spent.
    expect(limiter.allow("d")).toBe(false);
    expect(limiter.allow("a")).toBe(false);
  });

  it("resets the global cap once its window has elapsed", () => {
    let now = 0;
    const limiter = new RateLimiter(100, () => now, 1);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(false);
    now += 60_001;
    expect(limiter.allow("b")).toBe(true);
  });
});
