// Resolves ffmpeg/ffprobe binaries: PATH first (system ffmpeg 8), falling back to an explicit
// path (e.g. the `ffmpeg-static` package, already a dependency of this package) or a path passed
// in by the caller. ffmpeg-static ships only the `ffmpeg` binary, not `ffprobe` — if PATH has no
// ffprobe either, video checks that need it will fail with a clear error rather than silently
// skipping.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
    await execFileAsync(cmd, ['-version'])
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

/** Runs ffprobe and returns raw stdout (JSON text expected when called with -print_format json). */
export async function runFfprobe(ffprobe: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ffprobe, args, { maxBuffer: 64 << 20 })
  return stdout
}

/**
 * Runs ffmpeg for its stderr analysis report (filters like ebur128/blackdetect/volumedetect
 * write their results to stderr, not stdout, and ffmpeg exits 0 even when the filter "fails").
 */
export async function runFfmpegReport(ffmpeg: string, args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync(ffmpeg, args, { maxBuffer: 64 << 20 })
    return stderr
  } catch (err: any) {
    // ffmpeg can exit non-zero yet still have written a usable report to stderr.
    if (typeof err?.stderr === 'string') return err.stderr
    throw err
  }
}
