import { describe, expect, it } from 'vitest'
import { checkCaptions, parseSrt, parseVtt } from '../../src/qa/captions.js'

const SRT = `1
00:00:00,000 --> 00:00:02,000
Welcome to the tour.

2
00:00:02,500 --> 00:00:05,000
Click the Add button.
`

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Welcome to the tour.

00:00:02.500 --> 00:00:05.000
Click the Add button.
`

describe('parseSrt', () => {
  it('parses ordered cues', () => {
    const cues = parseSrt(SRT)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toEqual({ index: 1, startMs: 0, endMs: 2000, text: 'Welcome to the tour.' })
    expect(cues[1].startMs).toBe(2500)
  })

  it('throws on malformed timing', () => {
    expect(() => parseSrt('1\nnot a timing line\ntext')).toThrow()
  })
})

describe('parseVtt', () => {
  it('parses cues and skips the WEBVTT header', () => {
    const cues = parseVtt(VTT)
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('Welcome to the tour.')
    expect(cues[1].endMs).toBe(5000)
  })
})

describe('checkCaptions', () => {
  it('passes well-formed, in-order, non-overlapping cues', () => {
    const cues = parseSrt(SRT)
    const results = checkCaptions(cues, { videoDurationMs: 6000 })
    for (const r of results) expect(r.ok).toBe(true)
  })

  it('flags overlapping cues', () => {
    const overlapping = parseSrt(`1
00:00:00,000 --> 00:00:03,000
First.

2
00:00:02,000 --> 00:00:05,000
Second.
`)
    const results = checkCaptions(overlapping)
    const overlap = results.find((r) => r.check === 'captions:overlap')
    expect(overlap?.ok).toBe(false)
    expect(overlap?.problems[0]).toMatch(/starts/)
  })

  it('flags cues that run past the video duration', () => {
    const cues = parseSrt(SRT)
    const results = checkCaptions(cues, { videoDurationMs: 3000 })
    const dur = results.find((r) => r.check === 'captions:duration')
    expect(dur?.ok).toBe(false)
  })

  it('flags reading speed above the limit', () => {
    const fast = parseSrt(`1
00:00:00,000 --> 00:00:01,000
This sentence has far too many characters to be read in just one second by anyone.
`)
    const results = checkCaptions(fast, { maxCharsPerSecond: 20 })
    const speed = results.find((r) => r.check === 'captions:reading-speed')
    expect(speed?.ok).toBe(false)
  })

  it('flags lines longer than the max line length', () => {
    const longLine = parseSrt(`1
00:00:00,000 --> 00:00:05,000
This single line of caption text is deliberately far too long for a subtitle to ever display on screen.
`)
    const results = checkCaptions(longLine, { maxLineLength: 42 })
    const lineLength = results.find((r) => r.check === 'captions:line-length')
    expect(lineLength?.ok).toBe(false)
  })

  it('checks alignment against narration clip timings', () => {
    const cues = parseSrt(SRT)
    const aligned = checkCaptions(cues, {
      narration: [
        { startMs: 0, endMs: 2000, text: 'Welcome to the tour.' },
        { startMs: 2500, endMs: 5000, text: 'Click the Add button.' },
      ],
    })
    expect(aligned.find((r) => r.check === 'captions:alignment')?.ok).toBe(true)

    const misaligned = checkCaptions(cues, {
      narration: [
        { startMs: 0, endMs: 2000, text: 'Welcome to the tour.' },
        { startMs: 4000, endMs: 6000, text: 'Click the Add button.' },
      ],
    })
    expect(misaligned.find((r) => r.check === 'captions:alignment')?.ok).toBe(false)
  })

  it('reports an empty cue list as a failed parse check', () => {
    const results = checkCaptions([])
    expect(results).toEqual([expect.objectContaining({ check: 'captions:parse', ok: false })])
  })
})
