// Real kokoro-js smoke test: downloads the model (~90MB) on first run. Skipped by default —
// opt in with AIDA_TEST_KOKORO=1 or AIDA_TEST_SLOW=1 (see `npm run test:slow`) since this is
// slow/network-dependent and not appropriate for normal CI.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createKokoroProvider, DEFAULT_KOKORO_MODEL } from '../../src/voice/providers/kokoro.js'
import { silentWavBuffer } from '../../src/voice/wav.js'

const run =
  process.env.AIDA_TEST_KOKORO === '1' || process.env.AIDA_TEST_SLOW === '1' ? describe : describe.skip

run('kokoro provider (real model)', () => {
  it(
    'synthesizes a short sentence',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'aida-kokoro-'))
      try {
        const provider = createKokoroProvider()
        const result = await provider.synthesize({
          text: 'Welcome to the tour.',
          outPath: path.join(dir, 'clip.wav'),
        })
        expect(result.durationMs).toBeGreaterThan(0)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

describe('kokoro provider respects a per-call model override', () => {
  it('loads the model id from synthesize() options, not just the provider default', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aida-kokoro-override-'))
    try {
      const fromPretrained = vi.fn(async (model: string) => ({
        generate: async () => ({
          save: async (outPath: string) => {
            await writeFile(outPath, silentWavBuffer(100))
          },
        }),
        modelUsed: model,
      }))
      vi.doMock('kokoro-js', () => ({
        KokoroTTS: { from_pretrained: fromPretrained },
      }))
      vi.resetModules()

      const { createKokoroProvider: freshCreateKokoroProvider } = await import('../../src/voice/providers/kokoro.js')
      const provider = freshCreateKokoroProvider() // provider-level model left at the default
      const outPath = path.join(dir, 'clip.wav')
      await provider.synthesize({ text: 'hi', model: 'some-other-model', outPath })

      expect(fromPretrained).toHaveBeenCalledWith('some-other-model', expect.anything())
      expect(fromPretrained).not.toHaveBeenCalledWith(DEFAULT_KOKORO_MODEL, expect.anything())
    } finally {
      vi.doUnmock('kokoro-js')
      vi.resetModules()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
