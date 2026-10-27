import type { ModelPrice, UsageEntry } from "./types.js";

/**
 * Per-MTok pricing for models aida's default tiers can select (see
 * config/types.ts DEFAULT_MODEL_TIERS). Sourced from the Anthropic pricing
 * table (claude-api skill reference, cached 2026-06-24): $1/$5 per MTok
 * in/out for Haiku 4.5 ($0.10 cache read, 1/10 input rate), $2/$10 for
 * Sonnet 5 ($0.20 cache read), $4/$20 for Opus 5.5 ($0.20 cache read,
 * documented explicitly). Not placeholders.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
};

/**
 * Normalises a model id to `MODEL_PRICES`' hyphenated keys, so the dotted ids used elsewhere
 * (the Anthropic API's own id shape — "claude-haiku-4.5" — used in `docs/scope.md` and
 * `skills/references/tokens.md`) and a dated snapshot id (e.g.
 * "claude-sonnet-4-5-20251001" / "claude-sonnet-4.5-20251001") price the same as the bare id,
 * instead of silently costing $0 on a lookup miss: lowercases, turns every `.` into `-`, and
 * strips a trailing `-YYYYMMDD` date suffix.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-\d{8}$/, "");
}

/** Looks up pricing for a model id (normalised first — see `normalizeModelId`); `undefined` for
 * an unknown model (never throws). */
export function priceFor(model: string): ModelPrice | undefined {
  return MODEL_PRICES[normalizeModelId(model)];
}

/**
 * Per-character voice synthesis pricing, by provider id (docs/scope.md "Caching and budgets").
 * `kokoro` (local) and `silent` (no audio) are free; `minimax`/`elevenlabs` are hosted APIs that
 * actually bill per character — 0 here is a safe default until `config.voice.pricePerChar` (or
 * a walkthrough's own `voice.pricePerChar` override) sets the real rate for the account in use.
 */
export const VOICE_PRICES: Record<string, number> = {
  silent: 0,
  kokoro: 0,
  minimax: 0,
  elevenlabs: 0,
};

/** Per-character price for a voice provider; `pricePerChar` (from config/walkthrough) wins when given. */
export function voicePricePerChar(provider: string, pricePerChar?: number): number {
  if (pricePerChar !== undefined) return pricePerChar;
  return VOICE_PRICES[provider] ?? 0;
}

/** Cost in USD for a voice stage's billed characters, at the provider's per-char price. */
export function voiceCostUsd(provider: string, charsBilled: number, pricePerChar?: number): number {
  return charsBilled * voicePricePerChar(provider, pricePerChar);
}

/** Cost in USD for one entry's token counts, at the model's per-MTok price. 0 for an unknown model. */
export function costUsd(entry: Pick<UsageEntry, "model" | "input" | "output" | "cacheRead">): number {
  const price = priceFor(entry.model);
  if (!price) return 0;
  return (
    (entry.input / 1_000_000) * price.inputPerMTok +
    (entry.output / 1_000_000) * price.outputPerMTok +
    (entry.cacheRead / 1_000_000) * price.cacheReadPerMTok
  );
}
