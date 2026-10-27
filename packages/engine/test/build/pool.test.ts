import { describe, expect, it } from "vitest";
import { mapLimit } from "../../src/build/pool.js";

describe("mapLimit", () => {
  it("preserves result order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await mapLimit(items, 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("handles an empty list", async () => {
    const results = await mapLimit([], 2, async (x) => x);
    expect(results).toEqual([]);
  });

  it("handles limit greater than item count", async () => {
    const results = await mapLimit([1, 2], 10, async (x) => x * 2);
    expect(results).toEqual([2, 4]);
  });
});
