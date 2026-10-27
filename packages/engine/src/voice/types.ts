// Voice provider contract shared by all TTS backends (silent, kokoro, minimax, elevenlabs).

/** A word -> spoken-form replacement map, versioned so cache keys change when it does. */
export interface PronunciationMap {
  /** Bump (or hash) whenever `replacements` changes so cached clips invalidate correctly. */
  version: string
  /** Exact-word replacements, e.g. { ShopKit: "Shop Kit" }. Matched on word boundaries. */
  replacements: Record<string, string>
}

export interface SynthesizeOptions {
  /** Text to speak, already run through the pronunciation map. */
  text: string
  voice?: string
  /** Playback speed multiplier, provider-dependent. Defaults to 1. */
  speed?: number
  /** Model id/name, provider-dependent (e.g. minimax model, kokoro dtype profile). */
  model?: string
  /** Absolute path to write the resulting audio file to. */
  outPath: string
  /** Extra provider-specific knobs (e.g. kokoro dtype). */
  [key: string]: unknown
}

export interface SynthesizeResult {
  /** Absolute path to the written audio file (wav or mp3). */
  audioPath: string
  durationMs: number
}

export interface AvailabilityResult {
  available: boolean
  /** Why it's unavailable (missing env var, missing model, etc). Absent when available. */
  reason?: string
}

export interface SettingsKeyInput {
  model?: string
  voice?: string
  speed?: number
}

export interface VoiceProvider {
  id: string
  /** Default file extension this provider writes ('wav' | 'mp3'), used to size cache paths. */
  ext: 'wav' | 'mp3'
  /** Must never throw: reports missing key/model as `{available: false, reason}`. */
  available(): Promise<AvailabilityResult> | AvailabilityResult
  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>
  /**
   * A short string capturing every setting that affects the resulting audio for a call with
   * these (possibly undefined) overrides — including whatever defaults `synthesize()` would
   * apply itself (resolved model/voice, kokoro dtype, sample rate, stability, ...). Included
   * in the narration cache key so a change to a provider's own defaults invalidates affected
   * cache entries, instead of silently reusing stale clips.
   */
  settingsKey(input: SettingsKeyInput): string
}

export interface NarrationLine {
  id: string
  text: string
  voice?: string
  speed?: number
  model?: string
}

export interface NarrateOptions {
  model?: string
  voice?: string
  speed?: number
  /** Cache directory; default `.aida-cache/voice`. */
  cacheDir?: string
  pronunciation?: PronunciationMap
  /** Re-synthesize even if a cache hit exists. */
  force?: boolean
}

export interface NarrateResult {
  id: string
  audioPath: string
  durationMs: number
  cached: boolean
  /** Spoken text actually sent to the provider, after pronunciation replacements. */
  text: string
}

export interface NarrateSummary {
  synthesized: number
  cached: number
  /** Characters billed to the provider (spoken text of lines that were actually synthesized). */
  charsBilled: number
}

export interface NarrateReport {
  results: NarrateResult[]
  summary: NarrateSummary
}
