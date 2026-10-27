// Simple in-memory per-IP rate limit for /api/chat (build-plan.md M15 step 4: "per-IP simple
// rate limit in memory"). Good enough for a single Node process; a multi-instance deployment
// would need a shared store, which is explicitly out of scope here (no database by default).
interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

/** Caps how many per-client buckets the limiter holds at once — a backstop against unbounded
 * memory growth (review finding route.ts:56 + rate-limit.ts:10: "Map never pruned") on top of
 * the expiry sweep below, in case a burst of distinct clients arrives faster than buckets expire. */
const DEFAULT_MAX_BUCKETS = 10_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private globalWindowStart: number;
  private globalCount = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    /** Requests allowed across *all* clients per minute, independent of any one client's budget
     * — a floor under the per-IP limit so many distinct/spoofed IPs together still can't run the
     * owner's API key up without bound (review finding route.ts:56: "add a global per-minute cap
     * too"). Default effectively unlimited for callers that don't opt in. */
    private readonly globalPerMinute: number = Infinity,
    private readonly maxBuckets: number = DEFAULT_MAX_BUCKETS,
  ) {
    this.globalWindowStart = this.now();
  }

  /** Returns true when `clientId` is still under its per-minute budget *and* the global
   * per-minute budget (and records this call against both). Expired per-client buckets are
   * swept on every call so the map never grows unboundedly with one-off clients. */
  allow(clientId: string): boolean {
    const now = this.now();
    this.evictExpired(now);

    if (now - this.globalWindowStart >= WINDOW_MS) {
      this.globalWindowStart = now;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.globalPerMinute) return false;

    const bucket = this.buckets.get(clientId);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        // Every bucket is still live (the eviction sweep above found nothing to drop) and the
        // map is full — refuse rather than grow without bound.
        return false;
      }
      this.buckets.set(clientId, { count: 1, windowStart: now });
      this.globalCount += 1;
      return true;
    }
    if (bucket.count >= this.perMinute) return false;
    bucket.count += 1;
    this.globalCount += 1;
    return true;
  }

  private evictExpired(now: number): void {
    for (const [id, bucket] of this.buckets) {
      if (now - bucket.windowStart >= WINDOW_MS) this.buckets.delete(id);
    }
  }

  /** Test/diagnostic hook — how many per-client buckets are currently held. */
  get size(): number {
    return this.buckets.size;
  }
}
