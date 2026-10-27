/** Model tier names used to pick a default model per stage; see config/types.ts ModelTiers. */
export type ModelTier = "fast" | "standard" | "deep";

/** One recorded model call, as appended to a build's usage.jsonl ledger. */
export interface UsageEntry {
  /** ISO timestamp. */
  ts: string;
  /** Build stage that made the call, e.g. "voice", "pages", "discover". */
  stage: string;
  tier: ModelTier;
  /** Model id, e.g. "claude-sonnet-5". */
  model: string;
  input: number;
  output: number;
  /** Cache-read input tokens; defaults to 0 when not given. */
  cacheRead: number;
  /** True when `input`/`output` are an estimate rather than a real call's reported counts (e.g.
   * `references/tokens.md`'s per-page inspect-vs-source-read comparison) — kept separate from
   * real usage in `UsageReport` so a report's real total is never inflated by a guess. */
  estimate?: boolean;
  /** Free-text note on this entry — why it was recorded, what it estimates, etc. */
  note?: string;
}

/** Per-MTok (million token) pricing for a model. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

/** One aggregated row in a usage report, grouped by model + tier + estimate (an estimated entry
 * never shares a row with a real one, even for the same model/tier — see `reportUsage`). */
export interface UsageTotalsRow {
  model: string;
  tier: ModelTier;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  estimate: boolean;
}

export interface UsageReport {
  entries: UsageEntry[];
  totals: UsageTotalsRow[];
  /** Real (non-estimate) totals — what the run actually spent. */
  totalCostUsd: number;
  totalTokens: number;
  /** Estimated-entry totals, reported separately so they never inflate the real total above. */
  estimatedCostUsd: number;
  estimatedTokens: number;
}
