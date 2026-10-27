import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, normalizeModelId, priceFor } from "./prices.js";
import type { UsageEntry, UsageReport, UsageTotalsRow } from "./types.js";

/** Path to a build dir's usage ledger (one JSON line per recorded model call). */
export function ledgerPath(buildDir: string): string {
  return join(buildDir, "usage.jsonl");
}

/** Appends one usage entry, filling `ts` when omitted. Creates `buildDir` if missing. */
export function appendUsage(
  buildDir: string,
  entry: Omit<UsageEntry, "ts"> & { ts?: string },
): UsageEntry {
  const full: UsageEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    stage: entry.stage,
    tier: entry.tier,
    model: entry.model,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead ?? 0,
    ...(entry.estimate ? { estimate: true } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };

  if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
  appendFileSync(ledgerPath(buildDir), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** Reads every entry from a build's usage ledger. `[]` if no ledger exists yet; skips unparsable lines. */
export function readUsage(buildDir: string): UsageEntry[] {
  const path = ledgerPath(buildDir);
  if (!existsSync(path)) return [];

  const text = readFileSync(path, "utf8");
  const entries: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageEntry;
      entries.push({
        ts: parsed.ts,
        stage: parsed.stage,
        tier: parsed.tier,
        model: parsed.model,
        input: parsed.input,
        output: parsed.output,
        cacheRead: parsed.cacheRead ?? 0,
        ...(parsed.estimate ? { estimate: true } : {}),
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      });
    } catch {
      // tolerate/skip unparsable lines
    }
  }
  return entries;
}

/**
 * Aggregates a build's usage ledger into per-model/tier totals and overall cost/tokens.
 * Pass `since` (an ISO timestamp, usually a run's start time) to count only entries recorded at
 * or after it — the ledger file accumulates across every build in a build dir, so without this
 * a per-run budget check would see every past run's spend too (docs/scope.md "Caching and
 * budgets": "stops at the per-run budget cap").
 */
export function reportUsage(buildDir: string, since?: string): UsageReport {
  const all = readUsage(buildDir);
  const entries = since === undefined ? all : all.filter((e) => e.ts >= since);
  const rows = new Map<string, UsageTotalsRow>();

  for (const entry of entries) {
    // Group by normalized model id so dotted/hyphenated/dated variants of the same model
    // (e.g. "claude-haiku-4.5" and "claude-haiku-4-5") land in one row instead of appearing as
    // separate models. An estimated entry never shares a row with a real one for the same
    // model/tier, so an estimate can never quietly inflate a real total.
    const normalized = normalizeModelId(entry.model);
    const estimate = Boolean(entry.estimate);
    const key = `${normalized}\u0000${entry.tier}\u0000${estimate}`;
    let row = rows.get(key);
    if (!row) {
      row = { model: normalized, tier: entry.tier, calls: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, estimate };
      rows.set(key, row);
    }
    row.calls += 1;
    row.input += entry.input;
    row.output += entry.output;
    row.cacheRead += entry.cacheRead;
    row.costUsd += costUsd(entry);
  }

  const totals = [...rows.values()].sort((a, b) => (a.model === b.model ? a.tier.localeCompare(b.tier) : a.model.localeCompare(b.model)));
  const real = entries.filter((e) => !e.estimate);
  const estimated = entries.filter((e) => e.estimate);
  const totalCostUsd = totals.filter((r) => !r.estimate).reduce((sum, r) => sum + r.costUsd, 0);
  const totalTokens = real.reduce((sum, e) => sum + e.input + e.output + e.cacheRead, 0);
  const estimatedCostUsd = totals.filter((r) => r.estimate).reduce((sum, r) => sum + r.costUsd, 0);
  const estimatedTokens = estimated.reduce((sum, e) => sum + e.input + e.output + e.cacheRead, 0);

  return { entries, totals, totalCostUsd, totalTokens, estimatedCostUsd, estimatedTokens };
}

/** Terse multi-line text summary: one line per model/tier row, then a total line — estimated
 * rows/total are always reported separately from real ones, never folded into the same number. */
export function formatUsageReport(report: UsageReport): string {
  const lines: string[] = [];
  for (const row of report.totals) {
    const unknown = priceFor(row.model) ? "" : " (unpriced — unknown model, cost=0)";
    const estimateTag = row.estimate ? " [estimate]" : "";
    lines.push(
      `${row.model} [${row.tier}]${estimateTag}: ${row.calls} call(s), in=${row.input} out=${row.output} cacheRead=${row.cacheRead}, $${row.costUsd.toFixed(4)}${unknown}`,
    );
  }
  lines.push(`total: ${report.totalTokens} tokens, $${report.totalCostUsd.toFixed(4)}`);
  if (report.estimatedTokens > 0 || report.estimatedCostUsd > 0) {
    lines.push(`estimated (not counted above): ${report.estimatedTokens} tokens, $${report.estimatedCostUsd.toFixed(4)}`);
  }
  return lines.join("\n");
}
