// MiniMax provider, ported from the original pipeline's tts.mjs.
// Key/base come only from env (MINIMAX_API_KEY / MINIMAX_API_BASE) — never read files outside
// the repo, never log the key.
import { writeFile } from 'node:fs/promises'
import type { SynthesizeOptions, SynthesizeResult, VoiceProvider } from '../types.js'
import { probeDurationMs } from '../wav.js'

export const DEFAULT_MINIMAX_MODEL = 'speech-2.8-hd'
export const DEFAULT_MINIMAX_BASE = 'https://api.minimax.io'
export const DEFAULT_MINIMAX_SAMPLE_RATE = 44100
export const DEFAULT_MINIMAX_BITRATE = 128000

interface MiniMaxResponse {
  base_resp?: { status_code?: number; status_msg?: string }
  data?: { audio?: string }
}

export function createMiniMaxProvider(): VoiceProvider {
  return {
    id: 'minimax',
    ext: 'mp3',
    available() {
      if (!process.env.MINIMAX_API_KEY) {
        return { available: false, reason: 'MINIMAX_API_KEY not set' }
      }
      return { available: true }
    },
    settingsKey(input) {
      const model = input.model ?? DEFAULT_MINIMAX_MODEL
      const voice = input.voice ?? ''
      const speed = input.speed ?? 1
      return `${model}:${voice}:${speed}:${DEFAULT_MINIMAX_SAMPLE_RATE}:${DEFAULT_MINIMAX_BITRATE}`
    },
    async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
      const apiKey = process.env.MINIMAX_API_KEY
      if (!apiKey) throw new Error('MINIMAX_API_KEY not set')
      const base = process.env.MINIMAX_API_BASE || DEFAULT_MINIMAX_BASE
      const model = options.model ?? DEFAULT_MINIMAX_MODEL
      const voiceId = options.voice
      if (!voiceId) throw new Error('minimax provider requires a voice (voice_id)')
      const speed = options.speed ?? 1

      const res = await fetch(`${base}/v1/t2a_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          text: options.text,
          stream: false,
          language_boost: 'English',
          output_format: 'hex',
          voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
          audio_setting: {
            sample_rate: DEFAULT_MINIMAX_SAMPLE_RATE,
            bitrate: DEFAULT_MINIMAX_BITRATE,
            format: 'mp3',
            channel: 1,
          },
        }),
      })
      const payload = (await res.json()) as MiniMaxResponse
      const status = payload?.base_resp?.status_code
      if (!res.ok || (status !== undefined && status !== 0) || !payload?.data?.audio) {
        throw new Error(`MiniMax failed: ${payload?.base_resp?.status_msg ?? `HTTP ${res.status}`}`)
      }
      const buffer = Buffer.from(payload.data.audio, 'hex')
      await writeFile(options.outPath, buffer)
      const durationMs = await probeDurationMs(options.outPath, buffer)
      return { audioPath: options.outPath, durationMs }
    },
  }
}
