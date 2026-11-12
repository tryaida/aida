// Resolves ffmpeg/ffprobe binaries: PATH first (system ffmpeg 8), falling back to an explicit
// path (e.g. the `ffmpeg-static` package, already a dependency of this package) or a path passed
// in by the caller. ffmpeg-static ships only the `ffmpeg` binary, not `ffprobe` — if PATH has no
// ffprobe either, video checks that need it will fail with a clear error rather than silently
// skipping.
//
// Every run goes through render/media-tool.ts: no stdin, SIGKILLed after a time limit (scaled
// with the video's length for full decodes) or when the caller's AbortSignal aborts.
import { mediaTimeoutMs, PROBE_TIMEOUT_MS, runMediaTool, SHORT_TOOL_TIMEOUT_MS, spawnMediaTool } from '../render/media-tool.js'

export interface FfmpegTools {
  ffmpeg: string
  ffprobe: string
}

export interface ResolveFfmpegOptions {
  /** Explicit ffmpeg binary path, e.g. from the `ffmpeg-static` package. Skips PATH probing. */
  ffmpegPath?: string
  /** Explicit ffprobe binary path. Skips PATH probing. */
  ffprobePath?: string
}

let cached: FfmpegTools | undefined

async function works(cmd: string): Promise<boolean> {
  try {
    await runMediaTool(cmd, ['-version'], { timeoutMs: SHORT_TOOL_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

async function ffmpegStaticPath(): Promise<string | undefined> {
  try {
    const mod: any = await import('ffmpeg-static')
    const p = mod.default ?? mod
    return typeof p === 'string' ? p : undefined
  } catch {
    return undefined
  }
}

/**
 * Finds working ffmpeg/ffprobe binaries. Order: explicit option, then PATH, then (ffmpeg only)
 * the `ffmpeg-static` package. Caches the PATH-resolved result across calls with no explicit
 * options, since `-version` is cheap but not free.
 */
export async function resolveFfmpegTools(opts: ResolveFfmpegOptions = {}): Promise<FfmpegTools> {
  if (!opts.ffmpegPath && !opts.ffprobePath && cached) return cached

  let ffmpeg = opts.ffmpegPath
  if (!ffmpeg) {
    if (await works('ffmpeg')) ffmpeg = 'ffmpeg'
    else {
      const staticPath = await ffmpegStaticPath()
      if (staticPath && (await works(staticPath))) ffmpeg = staticPath
    }
  }
  if (!ffmpeg) throw new Error('no working ffmpeg found on PATH or via ffmpeg-static')

  let ffprobe = opts.ffprobePath
  if (!ffprobe) {
    if (await works('ffprobe')) ffprobe = 'ffprobe'
  }
  if (!ffprobe) throw new Error('no working ffprobe found on PATH (ffmpeg-static does not ship ffprobe; pass ffprobePath)')

  const tools = { ffmpeg, ffprobe }
  if (!opts.ffmpegPath && !opts.ffprobePath) cached = tools
  return tools
}

/** Time limit and stop signal for a QA run of ffmpeg or ffprobe. */
export interface QaToolOptions {
  /** The video's length, in seconds: a full decode's time limit scales with it (`mediaTimeoutMs`). */
  durationSec?: number
  /** Overrides the time limit. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Runs ffprobe and returns raw stdout (JSON text expected when called with -print_format json).
 * A header probe: `PROBE_TIMEOUT_MS` unless `timeoutMs` says otherwise. */
export async function runFfprobe(ffprobe: string, args: string[], opts: QaToolOptions = {}): Promise<string> {
  return runMediaTool(ffprobe, args, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal })
}

/**
 * Runs ffmpeg for its stderr analysis report (filters like ebur128/blackdetect/volumedetect
 * write their results to stderr, not stdout, and ffmpeg exits 0 even when the filter "fails").
 */
export async function runFfmpegReport(ffmpeg: string, args: string[], opts: QaToolOptions = {}): Promise<string> {
  // ffmpeg can exit non-zero yet still have written a usable report to stderr, so any exit
  // status returns it; only a failure to start, a time-out or an abort throws.
  const run = await spawnMediaTool(ffmpeg, args, { timeoutMs: opts.timeoutMs ?? mediaTimeoutMs(opts.durationSec), signal: opts.signal, fullStderr: true })
  return run.stderr
}
