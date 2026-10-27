import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSilentProvider } from '../../src/voice/providers/silent.js'

describe('silent provider', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aida-voice-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is always available', async () => {
    const provider = createSilentProvider()
    expect(await provider.available()).toEqual({ available: true })
  })

  it('sizes duration by word count at the configured words-per-minute', async () => {
    const provider = createSilentProvider({ wordsPerMinute: 150 })
    const outPath = path.join(dir, 'clip.wav')
    const words = Array.from({ length: 75 }, () => 'word').join(' ')
    const result = await provider.synthesize({ text: words, outPath })
    expect(result.audioPath).toBe(outPath)
    expect(result.durationMs).toBeCloseTo(30_000, -2) // 75 words @ 150wpm = 30s
    const written = await readFile(outPath)
    expect(written.toString('ascii', 0, 4)).toBe('RIFF')
  })

  it('longer text yields longer audio', async () => {
    const provider = createSilentProvider()
    const short = await provider.synthesize({ text: 'hi', outPath: path.join(dir, 'a.wav') })
    const long = await provider.synthesize({
      text: Array.from({ length: 50 }, () => 'word').join(' '),
      outPath: path.join(dir, 'b.wav'),
    })
    expect(long.durationMs).toBeGreaterThan(short.durationMs)
  })
})
