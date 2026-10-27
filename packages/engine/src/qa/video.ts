// Video QA checks, ported from the original pipeline's qa.mjs: loudness, black frames,
// duration, resolution/fps, colour range/pix_fmt, audio presence. Each check is independent and
// returns a QaCheckResult; callers decide which to run and with what tolerances.
import { existsSync, statSync } from 'node:fs'
import { resolveFfmpegTools, runFfmpegReport, runFfprobe, type ResolveFfmpegOptions } from './ffmpeg.js'
import { qaCheck, type QaCheckResult } from './types.js'

export interface VideoCheckOptions extends ResolveFfmpegOptions {
  /** Target integrated loudness in LUFS. Default -16 (EBU R128 streaming target). */
  targetLufs?: number
  /** Allowed +/- deviation from targetLufs. Default 2. */
  loudnessToleranceLufs?: number
  /** Max allowed true peak in dBTP. Default -1. */
  maxTruePeakDbtp?: number
  /** blackdetect minimum black duration (seconds). Default 0.25. */
  blackMinDurationSec?: number
  /** blackdetect pixel black threshold (0-1). Default 0.06. */
  blackPixelThreshold?: number
  minDurationSec?: number
  maxDurationSec?: number
  expectedWidth?: number
  expectedHeight?: number
  /** Expected frame rate (fps); checked with a small tolerance. */
  expectedFps?: number
  expectedPixFmt?: string // e.g. 'yuv420p'
  expectedColorRange?: string // e.g. 'tv'
  /** Any of these color_space/color_primaries/color_trc tags counts as a match (bt709 family). */
  expectedColorTags?: string[]
  requireAudio?: boolean
}

interface FfprobeStream {
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_primaries?: string
  color_transfer?: string
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
}

interface FfprobeOutput {
  streams: FfprobeStream[]
  format: { format_name: string; duration: string }
}

function parseFrameRate(r?: string): number | undefined {
  if (!r) return undefined
  const [num, den] = r.split('/').map(Number)
  if (!den) return num
  return num / den
}

async function probe(videoPath: string, ffprobe: string): Promise<FfprobeOutput> {
  const out = await runFfprobe(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoPath])
  return JSON.parse(out)
}

/** Runs all video checks against one MP4 (or other ffprobe-readable container). */
export async function checkVideo(videoPath: string, opts: VideoCheckOptions = {}): Promise<QaCheckResult[]> {
  if (!existsSync(videoPath)) {
    return [qaCheck('video:exists', false, `no file at ${videoPath}`, [`missing video file: ${videoPath}`])]
  }

  const tools = await resolveFfmpegTools(opts)
  const info = await probe(videoPath, tools.ffprobe)
  const checks: QaCheckResult[] = []

  const video = info.streams.find((s) => s.codec_type === 'video')
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  const duration = Number(info.format.duration)
  const sizeMb = statSync(videoPath).size / 1e6

  checks.push(qaCheck('video:exists', true, `${(info.format.format_name)}, ${sizeMb.toFixed(1)} MB`))

  // Resolution / fps
  const fps = parseFrameRate(video?.r_frame_rate)
  {
    const problems: string[] = []
    if (!video) problems.push('no video stream found')
    if (opts.expectedWidth !== undefined && video?.width !== opts.expectedWidth) {
      problems.push(`width ${video?.width} != expected ${opts.expectedWidth}`)
    }
    if (opts.expectedHeight !== undefined && video?.height !== opts.expectedHeight) {
      problems.push(`height ${video?.height} != expected ${opts.expectedHeight}`)
    }
    if (opts.expectedFps !== undefined && (fps === undefined || Math.abs(fps - opts.expectedFps) > 0.05)) {
      problems.push(`fps ${fps} != expected ${opts.expectedFps}`)
    }
    checks.push(qaCheck(
      'video:resolution-fps',
      problems.length === 0,
      `${video?.width}x${video?.height} @ ${fps?.toFixed(2)} fps`,
      problems,
    ))
  }

  // Colour: pix_fmt / range / bt709-family tags.
  {
    const problems: string[] = []
    if (opts.expectedPixFmt && video?.pix_fmt !== opts.expectedPixFmt) {
      problems.push(`pix_fmt ${video?.pix_fmt} != expected ${opts.expectedPixFmt}`)
    }
    if (opts.expectedColorRange && video?.color_range !== opts.expectedColorRange) {
      problems.push(`color_range ${video?.color_range} != expected ${opts.expectedColorRange}`)
    }
    if (opts.expectedColorTags && opts.expectedColorTags.length > 0) {
      const tags = [video?.color_space, video?.color_primaries, video?.color_transfer].filter(Boolean) as string[]
      const matches = tags.some((t) => opts.expectedColorTags!.includes(t))
      if (!matches) problems.push(`colour tags [${tags.join(', ')}] don't match any of [${opts.expectedColorTags.join(', ')}]`)
    }
    checks.push(qaCheck(
      'video:colour',
      problems.length === 0,
      `${video?.pix_fmt} (${video?.color_range}/${video?.color_space})`,
      problems,
    ))
  }

  // Duration.
  {
    const min = opts.minDurationSec
    const max = opts.maxDurationSec
    const problems: string[] = []
    if (!Number.isFinite(duration)) problems.push('could not read duration')
    if (min !== undefined && duration < min) problems.push(`duration ${duration.toFixed(1)}s below min ${min}s`)
    if (max !== undefined && duration > max) problems.push(`duration ${duration.toFixed(1)}s above max ${max}s`)
    checks.push(qaCheck('video:duration', problems.length === 0, `${duration.toFixed(1)}s`, problems))
  }

  // Audio presence.
  {
    const requireAudio = opts.requireAudio ?? true
    const ok = !requireAudio || Boolean(audio)
    const problems = ok ? [] : ['no audio stream found']
    const details = audio
      ? `${audio.codec_name} ${audio.sample_rate} Hz, ${audio.channels} ch`
      : 'no audio stream'
    checks.push(qaCheck('video:audio-present', ok, details, problems))
  }

  // Loudness (EBU R128), only if there's audio to measure.
  if (audio) {
    checks.push(await checkLoudness(videoPath, tools.ffmpeg, opts))
  }

  // Black frames.
  checks.push(await checkBlackFrames(videoPath, tools.ffmpeg, opts))

  return checks
}

async function checkLoudness(videoPath: string, ffmpeg: string, opts: VideoCheckOptions): Promise<QaCheckResult> {
  const target = opts.targetLufs ?? -16
  const tolerance = opts.loudnessToleranceLufs ?? 2
  const maxTruePeak = opts.maxTruePeakDbtp ?? -1
  const report = await runFfmpegReport(ffmpeg, ['-nostats', '-i', videoPath, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = report.split('Summary:').pop() ?? ''
  const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1])
  const truePeak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1])
  const problems: string[] = []
  if (!Number.isFinite(integrated)) problems.push('could not read integrated loudness from ffmpeg ebur128 output')
  else if (Math.abs(integrated - target) > tolerance) {
    problems.push(`integrated loudness ${integrated} LUFS outside ${target}±${tolerance} LUFS`)
  }
  if (Number.isFinite(truePeak) && truePeak > maxTruePeak) {
    problems.push(`true peak ${truePeak} dBFS above max ${maxTruePeak} dBFS`)
  }
  return qaCheck(
    'video:loudness',
    problems.length === 0,
    `integrated ${integrated} LUFS, true peak ${truePeak} dBFS (target ${target}±${tolerance} LUFS, peak ≤ ${maxTruePeak} dBTP)`,
    problems,
  )
}

async function checkBlackFrames(videoPath: string, ffmpeg: string, opts: VideoCheckOptions): Promise<QaCheckResult> {
  const minDuration = opts.blackMinDurationSec ?? 0.25
  const pixThreshold = opts.blackPixelThreshold ?? 0.06
  const report = await runFfmpegReport(ffmpeg, [
    '-i', videoPath, '-map', '0:v', '-vf', `blackdetect=d=${minDuration}:pix_th=${pixThreshold}`, '-an', '-f', 'null', '-',
  ])
  const blacks = [...report.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${m[1]}–${m[2]}s`)
  return qaCheck('video:black-frames', blacks.length === 0, blacks.length ? blacks.join(', ') : 'none detected', blacks)
}
