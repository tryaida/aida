// Optional per-phase timing instrumentation for capture (M11). Off by default — zero overhead
// (every helper below short-circuits to a plain call) unless `AIDA_PROFILE=1` is set in the
// environment. Used by runner.ts (navigation/actions split by subtraction, screenshot), mask.ts
// (masking) and settle.ts (settle waits), plus frame-diff.ts (frame-diff) so one capture run
// (`aida capture` / build pipeline, both going through `withFrameStabilization`) can print a
// single combined report covering every phase named in docs/build-plan.md M11.
let enabled = process.env.AIDA_PROFILE === "1";
let totals: Record<string, number> = {};
let counts: Record<string, number> = {};

/** True when `AIDA_PROFILE=1` — callers can skip building profiling-only data when false. */
export function isProfiling(): boolean {
  return enabled;
}

/** Clears accumulated phase timings. Call once at the start of a run that will be reported. */
export function resetProfile(): void {
  enabled = process.env.AIDA_PROFILE === "1";
  totals = {};
  counts = {};
}

function record(phase: string, ms: number): void {
  totals[phase] = (totals[phase] ?? 0) + ms;
  counts[phase] = (counts[phase] ?? 0) + 1;
}

/** Times an async `fn()` under `phase` when profiling is on; otherwise just awaits it. */
export async function profileAsync<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(phase, performance.now() - start);
  }
}

/** Times a sync `fn()` under `phase` when profiling is on; otherwise just calls it. */
export function profileSync<T>(phase: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(phase, performance.now() - start);
  }
}

/**
 * Renders a report for the named phases plus a derived "navigation/actions" bucket (the part of
 * `totalMs` not accounted for by any named phase — clicks, typing, waits for locators, page.goto,
 * etc., which aren't worth instrumenting individually). Returns `null` when profiling is off.
 */
export function profileReport(totalMs: number, phases: string[] = ["settle", "masking", "screenshot", "frame-diff"]): string | null {
  if (!enabled) return null;
  const accounted = phases.reduce((sum, p) => sum + (totals[p] ?? 0), 0);
  const other = Math.max(0, totalMs - accounted);
  const lines = [
    `navigation/actions: ${other.toFixed(0)}ms`,
    ...phases.map((p) => `${p}: ${(totals[p] ?? 0).toFixed(0)}ms (${counts[p] ?? 0}x)`),
    `total: ${totalMs.toFixed(0)}ms`,
  ];
  return `[aida capture profile]\n  ${lines.join("\n  ")}`;
}
