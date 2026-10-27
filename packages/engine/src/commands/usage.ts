import { appendUsage, formatUsageReport, priceFor, reportUsage } from "../usage/index.js";
import type { ModelTier } from "../usage/index.js";
import { DEFAULT_MODEL_TIERS } from "../config/types.js";

const TIERS: ModelTier[] = ["fast", "standard", "deep"];

export interface RunUsageAddOptions {
  buildDir: string;
  stage: string;
  tier: ModelTier;
  /** Model id. Required for a real entry; optional when `estimate` is set — an estimate priced
   * at the tier's default model (`DEFAULT_MODEL_TIERS`) is still useful (e.g. a rough token-cost
   * guess before picking a real model), and the note/entry mark it as tier-priced rather than
   * tied to a specific call. */
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  /** Marks this entry as an estimate (e.g. a token-cost guess, not a real call's reported
   * counts) — reports keep estimated totals separate from real ones (see usage/ledger.ts). */
  estimate?: boolean;
  /** Free-text note on this entry — why it was recorded, what it estimates, etc. */
  note?: string;
}

/** Runs `aida usage add`: appends one model-call entry to the build's usage ledger. `--model`
 * is required unless `--estimate` is set, in which case an omitted model defaults to the tier's
 * default model (`DEFAULT_MODEL_TIERS`) and the note is marked to say so. */
export function runUsageAdd(opts: RunUsageAddOptions, json: boolean): number {
  if (!TIERS.includes(opts.tier)) {
    const message = `invalid tier "${opts.tier}" (expected one of: ${TIERS.join(", ")})`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`usage add failed: ${message}`);
    return 1;
  }

  if (!opts.model && !opts.estimate) {
    const message = "--model is required unless --estimate is set";
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`usage add failed: ${message}`);
    return 1;
  }

  const tierDefaulted = !opts.model;
  const model = opts.model ?? DEFAULT_MODEL_TIERS[opts.tier];
  const note = tierDefaulted
    ? `${opts.note ? `${opts.note} — ` : ""}priced at ${opts.tier} tier's default model (no --model given)`
    : opts.note;

  const entry = appendUsage(opts.buildDir, {
    stage: opts.stage,
    tier: opts.tier,
    model,
    input: opts.input,
    output: opts.output,
    cacheRead: opts.cacheRead ?? 0,
    estimate: opts.estimate,
    note,
  });

  const known = Boolean(priceFor(entry.model));

  if (json) {
    console.log(JSON.stringify({ ok: true, entry, knownModel: known }));
  } else {
    console.log(
      `recorded ${entry.stage}/${entry.tier} ${entry.model}${entry.estimate ? " [estimate]" : ""}: in=${entry.input} out=${entry.output} cacheRead=${entry.cacheRead}` +
        (known ? "" : " (unknown model, cost will report as 0)") +
        (entry.note ? ` — ${entry.note}` : ""),
    );
  }
  return 0;
}

/** Runs `aida usage report`: prints the build's aggregated token/cost usage. */
export function runUsageReport(buildDir: string, json: boolean): number {
  const report = reportUsage(buildDir);

  if (json) {
    console.log(JSON.stringify({ ok: true, ...report }));
  } else {
    console.log(formatUsageReport(report));
  }
  return 0;
}
