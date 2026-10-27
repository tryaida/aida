// Caption QA: parse SRT/VTT, check cue ordering/overlap, duration coverage, reading speed, line
// length, and (optionally) alignment against narration clip timings from the voice/render stages.
import { qaCheck, type QaCheckResult } from './types.js'

export interface Cue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface NarrationClip {
  startMs: number
  endMs: number
  text: string
}

export type CaptionFormat = 'srt' | 'vtt'

/** Detects format from a file path extension; defaults to 'srt' for unknown extensions. */
export function captionFormatFromPath(filePath: string): CaptionFormat {
  return filePath.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt'
}

function srtTimeToMs(t: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(t.trim())
  if (!m) throw new Error(`invalid SRT/VTT timestamp: ${t}`)
  const [, h, mi, s, ms] = m
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms)
}

/** Parses an SRT file's contents into ordered cues. Throws on malformed timing lines. */
export function parseSrt(content: string): Cue[] {
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\n+/).filter((b) => b.trim())
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    // First line is usually a numeric index, but tolerate it being absent.
    let i = 0
    let index = cues.length + 1
    if (/^\d+$/.test(lines[0]?.trim() ?? '')) {
      index = Number(lines[0].trim())
      i = 1
    }
    const timing = lines[i]
    const m = /^(.+?)\s*-->\s*(.+?)(?:\s|$)/.exec(timing ?? '')
    if (!m) throw new Error(`cue ${index}: missing or malformed timing line: ${timing}`)
    const startMs = srtTimeToMs(m[1])
    const endMs = srtTimeToMs(m[2])
    const text = lines.slice(i + 1).join('\n').trim()
    cues.push({ index, startMs, endMs, text })
  }
  return cues
}

/** Parses a WebVTT file's contents into ordered cues. Skips header/NOTE/STYLE blocks. */
export function parseVtt(content: string): Cue[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const blocks = normalized.split(/\n\n+/).filter((b) => b.trim())
  const cues: Cue[] = []
  let autoIndex = 1
  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines[0].trim() === 'WEBVTT') continue
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0].trim())) continue
    let i = 0
    let index = autoIndex
    // Optional cue identifier line before the timing line.
    if (!lines[0].includes('-->')) {
      if (/^\d+$/.test(lines[0].trim())) index = Number(lines[0].trim())
      i = 1
    }
    const timing = lines[i]
    const m = /^(.+?)\s*-->\s*(.+?)(?:\s|$)/.exec(timing ?? '')
    if (!m) throw new Error(`cue ${index}: missing or malformed timing line: ${timing}`)
    const startMs = srtTimeToMs(m[1].replace('.', ','))
    const endMs = srtTimeToMs(m[2].replace('.', ','))
    const text = lines.slice(i + 1).join('\n').trim()
    cues.push({ index, startMs, endMs, text })
    autoIndex++
  }
  return cues
}

export function parseCaptions(content: string, format: CaptionFormat): Cue[] {
  return format === 'vtt' ? parseVtt(content) : parseSrt(content)
}

export interface CaptionCheckOptions {
  /** Known video duration, to check cues don't run past the end. */
  videoDurationMs?: number
  /** Max characters per second of cue duration. Default 20 (common subtitle guideline). */
  maxCharsPerSecond?: number
  /** Max characters per line. Default 42 (common subtitle guideline). */
  maxLineLength?: number
  /** Max lines per cue. Default 2. */
  maxLines?: number
  /** Narration clip timings to align captions against, e.g. from the render timeline. */
  narration?: NarrationClip[]
  /** Allowed drift between a cue and its matching narration clip. Default 300ms. */
  narrationToleranceMs?: number
}

/** Subtitle guideline defaults, shared by `checkCaptions` and `aida validate`'s text checks. */
export const DEFAULT_MAX_LINE_LENGTH = 42
export const DEFAULT_MAX_LINES = 2

/** One line-count or line-length problem in a single cue. `line` is the over-long line's text. */
export interface CueLineProblem {
  kind: 'line-count' | 'line-length'
  actual: number
  max: number
  line?: string
}

/** The `captions:line-length` check for one cue: too many lines, or any line too long. */
export function cueLineProblems(
  cue: Pick<Cue, 'text'>,
  opts: Pick<CaptionCheckOptions, 'maxLineLength' | 'maxLines'> = {},
): CueLineProblem[] {
  const maxLineLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const problems: CueLineProblem[] = []
  const lines = cue.text.split('\n')
  if (lines.length > maxLines) problems.push({ kind: 'line-count', actual: lines.length, max: maxLines })
  for (const line of lines) {
    const len = line.replace(/<[^>]+>/g, '').length
    if (len > maxLineLength) problems.push({ kind: 'line-length', actual: len, max: maxLineLength, line })
  }
  return problems
}

function cueCharCount(text: string): number {
  // Count visible characters only: strip basic tags and newlines.
  return text.replace(/<[^>]+>/g, '').replace(/\n/g, '').length
}

/** Runs all caption checks against already-parsed cues. */
export function checkCaptions(cues: Cue[], opts: CaptionCheckOptions = {}): QaCheckResult[] {
  const checks: QaCheckResult[] = []
  const maxCps = opts.maxCharsPerSecond ?? 20
  const maxLineLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES

  if (cues.length === 0) {
    return [qaCheck('captions:parse', false, 'no cues found', ['no cues parsed from captions file'])]
  }
  checks.push(qaCheck('captions:parse', true, `${cues.length} cues`))

  // Ordering: each cue's start >= previous start, and start < end.
  {
    const problems: string[] = []
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]
      if (c.endMs <= c.startMs) problems.push(`cue ${c.index}: end (${c.endMs}ms) <= start (${c.startMs}ms)`)
      if (i > 0 && c.startMs < cues[i - 1].startMs) problems.push(`cue ${c.index}: starts before previous cue`)
    }
    checks.push(qaCheck('captions:order', problems.length === 0, `${cues.length} cues checked`, problems))
  }

  // Non-overlapping: next cue's start should be >= this cue's end.
  {
    const problems: string[] = []
    for (let i = 1; i < cues.length; i++) {
      const prev = cues[i - 1]
      const cur = cues[i]
      if (cur.startMs < prev.endMs) {
        problems.push(`cue ${cur.index} starts (${cur.startMs}ms) before cue ${prev.index} ends (${prev.endMs}ms)`)
      }
    }
    checks.push(qaCheck('captions:overlap', problems.length === 0, `${cues.length} cues checked`, problems))
  }

  // Within video duration.
  if (opts.videoDurationMs !== undefined) {
    const problems: string[] = []
    const limit = opts.videoDurationMs
    for (const c of cues) {
      if (c.endMs > limit + 50) problems.push(`cue ${c.index} ends at ${c.endMs}ms, after video duration ${limit}ms`)
    }
    checks.push(qaCheck('captions:duration', problems.length === 0, `video ${limit}ms`, problems))
  }

  // Reading speed (chars/sec).
  {
    const problems: string[] = []
    for (const c of cues) {
      const durationSec = (c.endMs - c.startMs) / 1000
      if (durationSec <= 0) continue
      const cps = cueCharCount(c.text) / durationSec
      if (cps > maxCps) problems.push(`cue ${c.index}: ${cps.toFixed(1)} chars/sec above max ${maxCps}`)
    }
    checks.push(qaCheck('captions:reading-speed', problems.length === 0, `max ${maxCps} chars/sec`, problems))
  }

  // Line length / line count.
  {
    const problems: string[] = []
    for (const c of cues) {
      for (const p of cueLineProblems(c, { maxLineLength, maxLines })) {
        problems.push(
          p.kind === 'line-count'
            ? `cue ${c.index}: ${p.actual} lines above max ${p.max}`
            : `cue ${c.index}: line length ${p.actual} above max ${p.max}`,
        )
      }
    }
    checks.push(qaCheck('captions:line-length', problems.length === 0, `max ${maxLineLength} chars/line, ${maxLines} lines`, problems))
  }

  // Alignment against narration clip timings, if given.
  if (opts.narration && opts.narration.length > 0) {
    const tolerance = opts.narrationToleranceMs ?? 300
    const problems: string[] = []
    const narration = opts.narration
    if (narration.length !== cues.length) {
      problems.push(`${cues.length} cues vs ${narration.length} narration clips`)
    }
    const n = Math.min(cues.length, narration.length)
    for (let i = 0; i < n; i++) {
      const c = cues[i]
      const clip = narration[i]
      if (Math.abs(c.startMs - clip.startMs) > tolerance) {
        problems.push(`cue ${c.index} starts ${c.startMs}ms, narration clip starts ${clip.startMs}ms`)
      }
      if (Math.abs(c.endMs - clip.endMs) > tolerance) {
        problems.push(`cue ${c.index} ends ${c.endMs}ms, narration clip ends ${clip.endMs}ms`)
      }
    }
    checks.push(qaCheck('captions:alignment', problems.length === 0, `${n} cues checked against narration`, problems))
  }

  return checks
}
