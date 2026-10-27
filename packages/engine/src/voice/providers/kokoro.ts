// Kokoro provider: local TTS via kokoro-js (https://github.com/hexgrad/kokoro, ONNX port).
// Default voice provider — no key, no network cost per call, but the model (~90MB for q8)
// downloads on first use. The import is lazy so loading this module (and running the test
// suite) never pulls kokoro-js or its model in.
import { writeFile } from 'node:fs/promises'
import type { SynthesizeOptions, SynthesizeResult, VoiceProvider } from '../types.js'
import { probeDurationMs } from '../wav.js'

export const DEFAULT_KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const DEFAULT_KOKORO_DTYPE: KokoroDtype = 'q8'
export const DEFAULT_KOKORO_VOICE = 'af_heart'

export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'

export interface KokoroProviderOptions {
  model?: string
  /** onnxruntime quantization profile, default 'q8'. */
  dtype?: KokoroDtype
}

// Keyed by `${model}:${dtype}` so different configs don't collide; avoids reloading the
// model on every synthesize() call within a process.
const instances = new Map<string, Promise<any>>()

async function loadKokoro(model: string, dtype: KokoroDtype): Promise<any> {
  const key = `${model}:${dtype}`
  let instance = instances.get(key)
  if (!instance) {
    instance = import('kokoro-js').then(({ KokoroTTS }) => KokoroTTS.from_pretrained(model, { dtype }))
    instances.set(key, instance)
  }
  return instance
}

export function createKokoroProvider(opts: KokoroProviderOptions = {}): VoiceProvider {
  const model = opts.model ?? DEFAULT_KOKORO_MODEL
  const dtype = opts.dtype ?? DEFAULT_KOKORO_DTYPE
  return {
    id: 'kokoro',
    ext: 'wav',
    async available() {
      try {
        await import('kokoro-js')
        return { available: true }
      } catch (err) {
        return { available: false, reason: `kokoro-js not installed: ${(err as Error).message}` }
      }
    },
    settingsKey(input) {
      const effectiveModel = input.model ?? model
      const voice = input.voice ?? DEFAULT_KOKORO_VOICE
      const speed = input.speed ?? 1
      return `${effectiveModel}:${dtype}:${voice}:${speed}`
    },
    async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
      // Per-call model, when given, overrides the provider's default model id.
      const effectiveModel = options.model ?? model
      const tts = await loadKokoro(effectiveModel, dtype)
      const voice = options.voice ?? DEFAULT_KOKORO_VOICE
      const audio = await tts.generate(options.text, { voice, speed: options.speed ?? 1 })
      // kokoro-js RawAudio exposes save(path) which writes a WAV file.
      if (typeof audio.save === 'function') {
        await audio.save(options.outPath)
      } else if (audio.toWav) {
        await writeFile(options.outPath, Buffer.from(audio.toWav()))
      } else {
        throw new Error('kokoro-js returned an audio object with no save()/toWav()')
      }
      const durationMs = await probeDurationMs(options.outPath)
      return { audioPath: options.outPath, durationMs }
    },
  }
}
