import { describe, expect, it } from 'vitest'
import { estimateSpokenDurationMs, mp3DurationMs, probeDurationMs, silentWavBuffer, wavDurationMs } from '../../src/voice/wav.js'

/**
 * Builds a synthetic CBR MPEG1 Layer III buffer: `frameCount` frames at 128kbps/44100Hz,
 * each frame's payload zero-filled after a valid 4-byte header (frame length = 417 bytes).
 */
function cbrMp3Buffer(frameCount: number): Buffer {
  const frameLength = Math.floor((144 * 128000) / 44100) // 417, no padding bit set
  const buffer = Buffer.alloc(frameCount * frameLength)
  for (let i = 0; i < frameCount; i++) {
    const offset = i * frameLength
    // 11111111 111 (sync) 11 (MPEG1) 01 (Layer III) 1 (no CRC) | 1001 (bitrate idx=9 -> 128kbps) 00 (44100) 0 (no pad) 0 | ...
    buffer[offset] = 0xff
    buffer[offset + 1] = 0xfb // 1111 1011: version=11, layer=01, protection=1
    buffer[offset + 2] = 0x90 // bitrate index 1001=9 (128kbps), sampleRate 00=44100, pad 0
    buffer[offset + 3] = 0x00
  }
  return buffer
}

const SAMPLES_PER_MPEG1_LAYER3_FRAME = 1152

describe('silentWavBuffer / wavDurationMs', () => {
  it('round-trips a requested duration through the WAV header', () => {
    const buffer = silentWavBuffer(2000)
    const duration = wavDurationMs(buffer)
    expect(duration).toBeCloseTo(2000, 0)
  })

  it('produces silence (all-zero PCM data)', () => {
    const buffer = silentWavBuffer(100)
    const data = buffer.subarray(44)
    expect(data.every((byte) => byte === 0)).toBe(true)
  })

  it('throws on a non-WAV buffer', () => {
    expect(() => wavDurationMs(Buffer.from('not a wav'))).toThrow()
  })
})

describe('mp3DurationMs', () => {
  it('scans MPEG frame headers to compute duration without ffprobe', () => {
    const frames = 10
    const buffer = cbrMp3Buffer(frames)
    const expectedMs = (frames * SAMPLES_PER_MPEG1_LAYER3_FRAME) / 44100 * 1000
    expect(mp3DurationMs(buffer)).toBeCloseTo(expectedMs, 0)
  })

  it('skips a leading ID3v2 tag before scanning for frames', () => {
    const id3 = Buffer.alloc(10)
    id3.write('ID3', 0, 'ascii')
    id3[3] = 3 // version
    id3[6] = 0
    id3[7] = 0
    id3[8] = 0
    id3[9] = 0 // size 0 (sync-safe)
    const buffer = Buffer.concat([id3, cbrMp3Buffer(5)])
    const expectedMs = (5 * SAMPLES_PER_MPEG1_LAYER3_FRAME) / 44100 * 1000
    expect(mp3DurationMs(buffer)).toBeCloseTo(expectedMs, 0)
  })

  it('throws when no valid MPEG frame is found', () => {
    expect(() => mp3DurationMs(Buffer.from('not an mp3 at all'))).toThrow(/no MPEG audio frames/)
  })
})

describe('probeDurationMs (no ffprobe on PATH)', () => {
  it('computes duration for an mp3 buffer without throwing, and writes a usable result', async () => {
    const buffer = cbrMp3Buffer(20)
    const expectedMs = (20 * SAMPLES_PER_MPEG1_LAYER3_FRAME) / 44100 * 1000
    // This regression matters because mp3 providers (elevenlabs/minimax) already billed the
    // API call by the time probeDurationMs runs — it must not throw just because ffprobe is
    // missing, or the cache entry never gets written and the line is re-billed every run.
    const durationMs = await probeDurationMs('/nonexistent/clip.mp3', buffer)
    expect(durationMs).toBeCloseTo(expectedMs, 0)
  })
})

describe('estimateSpokenDurationMs', () => {
  it('scales with word count at the given words-per-minute', () => {
    const text = Array.from({ length: 150 }, () => 'word').join(' ')
    expect(estimateSpokenDurationMs(text, 150)).toBeCloseTo(60_000, -2)
  })

  it('has a sane floor for very short text', () => {
    expect(estimateSpokenDurationMs('hi', 150)).toBeGreaterThanOrEqual(300)
  })
})
