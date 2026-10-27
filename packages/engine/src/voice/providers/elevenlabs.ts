// ElevenLabs provider: standard text-to-speech REST endpoint. Key from env ELEVENLABS_API_KEY.
import { writeFile } from 'node:fs/promises'
import type { SynthesizeOptions, SynthesizeResult, VoiceProvider } from '../types.js'
import { probeDurationMs } from '../wav.js'

export const DEFAULT_ELEVENLABS_BASE = 'https://api.elevenlabs.io'
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2'
export const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM' // "Rachel", a standard voice id
export const DEFAULT_ELEVENLABS_STABILITY = 0.5
export const DEFAULT_ELEVENLABS_SIMILARITY_BOOST = 0.75

export function createElevenLabsProvider(): VoiceProvider {
  return {
    id: 'elevenlabs',
    ext: 'mp3',
    available() {
      if (!process.env.ELEVENLABS_API_KEY) {
        return { available: false, reason: 'ELEVENLABS_API_KEY not set' }
      }
      return { available: true }
    },
    settingsKey(input) {
      const voice = input.voice ?? DEFAULT_ELEVENLABS_VOICE
      const model = input.model ?? DEFAULT_ELEVENLABS_MODEL
      const speed = input.speed ?? 1
      return `${model}:${voice}:${speed}:${DEFAULT_ELEVENLABS_STABILITY}:${DEFAULT_ELEVENLABS_SIMILARITY_BOOST}`
    },
    async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
      const apiKey = process.env.ELEVENLABS_API_KEY
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set')
      const base = process.env.ELEVENLABS_API_BASE || DEFAULT_ELEVENLABS_BASE
      const voiceId = options.voice ?? DEFAULT_ELEVENLABS_VOICE
      const model = options.model ?? DEFAULT_ELEVENLABS_MODEL

      const res = await fetch(`${base}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: options.text,
          model_id: model,
          voice_settings: {
            stability: DEFAULT_ELEVENLABS_STABILITY,
            similarity_boost: DEFAULT_ELEVENLABS_SIMILARITY_BOOST,
            speed: options.speed ?? 1,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`ElevenLabs failed: HTTP ${res.status} ${body}`.trim())
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      await writeFile(options.outPath, buffer)
      const durationMs = await probeDurationMs(options.outPath, buffer)
      return { audioPath: options.outPath, durationMs }
    },
  }
}
