import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { narrate } from '../../src/voice/narrate.js'
import { createSilentProvider } from '../../src/voice/providers/silent.js'
import type { NarrationLine, SynthesizeOptions, SynthesizeResult, VoiceProvider } from '../../src/voice/types.js'

describe('narrate', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aida-voice-cache-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  const lines: NarrationLine[] = [
    { id: 'intro', text: 'Welcome to the tour.' },
    { id: 'step-1', text: 'Click the Add button.' },
  ]

  it('synthesizes on first run and reports a full miss', async () => {
    const provider = createSilentProvider()
    const { results, summary } = await narrate(lines, provider, { cacheDir })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.cached === false)).toBe(true)
    expect(summary).toEqual({ synthesized: 2, cached: 0, charsBilled: 'Welcome to the tour.'.length + 'Click the Add button.'.length })
  })

  it('reuses cached clips when lines are unchanged', async () => {
    const provider = createSilentProvider()
    await narrate(lines, provider, { cacheDir })
    const { results, summary } = await narrate(lines, provider, { cacheDir })
    expect(results.every((r) => r.cached === true)).toBe(true)
    expect(summary).toEqual({ synthesized: 0, cached: 2, charsBilled: 0 })
  })

  it('invalidates the cache when text changes', async () => {
    const provider = createSilentProvider()
    await narrate(lines, provider, { cacheDir })
    const changed = [{ ...lines[0], text: 'Welcome to the brand new tour.' }, lines[1]]
    const { summary } = await narrate(changed, provider, { cacheDir })
    expect(summary.synthesized).toBe(1)
    expect(summary.cached).toBe(1)
  })

  it('invalidates the cache when the pronunciation map version changes', async () => {
    const provider = createSilentProvider()
    const pronunciation = { version: '1', replacements: { ShopKit: 'Shop Kit' } }
    const kitLines: NarrationLine[] = [{ id: 'intro', text: 'Welcome to ShopKit.' }]

    const first = await narrate(kitLines, provider, { cacheDir, pronunciation })
    expect(first.results[0].text).toBe('Welcome to Shop Kit.')
    expect(first.summary.synthesized).toBe(1)

    const second = await narrate(kitLines, provider, { cacheDir, pronunciation })
    expect(second.summary.cached).toBe(1)

    const bumped = { version: '2', replacements: { ShopKit: 'Shop-Kit' } }
    const third = await narrate(kitLines, provider, { cacheDir, pronunciation: bumped })
    expect(third.summary.synthesized).toBe(1)
    expect(third.results[0].text).toBe('Welcome to Shop-Kit.')
  })

  it('invalidates the cache when voice or speed changes', async () => {
    const provider = createSilentProvider()
    await narrate(lines, provider, { cacheDir, voice: 'a' })
    const { summary } = await narrate(lines, provider, { cacheDir, voice: 'b' })
    expect(summary.synthesized).toBe(2)
  })

  it('force re-synthesizes even on a cache hit', async () => {
    const provider = createSilentProvider()
    await narrate(lines, provider, { cacheDir })
    const { summary } = await narrate(lines, provider, { cacheDir, force: true })
    expect(summary.synthesized).toBe(2)
    expect(summary.cached).toBe(0)
  })

  it('invalidates the cache when the provider settingsKey changes with model/voice unset', async () => {
    // Regression: the cache key used to hash only the raw (pre-default) model/voice/speed, so
    // a provider's own resolved defaults (kokoro dtype, elevenlabs stability, minimax sample
    // rate, ...) never invalidated the cache even when they changed. settingsKey() is how a
    // provider reports those resolved settings.
    let settings = 'settings-v1'
    const provider: VoiceProvider = {
      id: 'fake',
      ext: 'wav',
      available: () => ({ available: true }),
      settingsKey: () => settings,
      async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
        await writeFile(options.outPath, Buffer.from([]))
        return { audioPath: options.outPath, durationMs: 1000 }
      },
    }

    const line: NarrationLine[] = [{ id: 'intro', text: 'Welcome to the tour.' }]
    const first = await narrate(line, provider, { cacheDir })
    expect(first.summary.synthesized).toBe(1)

    const second = await narrate(line, provider, { cacheDir })
    expect(second.summary.cached).toBe(1)

    settings = 'settings-v2' // e.g. the provider's default model/dtype changed
    const third = await narrate(line, provider, { cacheDir })
    expect(third.summary.synthesized).toBe(1)
    expect(third.summary.cached).toBe(0)
  })
})
