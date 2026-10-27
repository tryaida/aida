// Silent provider: generates a silent WAV sized by a words-per-minute estimate.
// Used in tests and CI where no TTS key/model is available.
import { writeFile } from 'node:fs/promises'
import type { SynthesizeOptions, SynthesizeResult, VoiceProvider } from '../types.js'
import { estimateSpokenDurationMs, silentWavBuffer } from '../wav.js'

export interface SilentProviderOptions {
  wordsPerMinute?: number
}

export function createSilentProvider(opts: SilentProviderOptions = {}): VoiceProvider {
  const wordsPerMinute = opts.wordsPerMinute ?? 150
  return {
    id: 'silent',
    ext: 'wav',
    available() {
      return { available: true }
    },
    settingsKey() {
      // Duration is derived purely from word count at this configured rate; model/voice/speed
      // are ignored by this provider.
      return `wpm:${wordsPerMinute}`
    },
    async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
      const durationMs = estimateSpokenDurationMs(options.text, wordsPerMinute)
      const buffer = silentWavBuffer(durationMs)
      await writeFile(options.outPath, buffer)
      return { audioPath: options.outPath, durationMs }
    },
  }
}
