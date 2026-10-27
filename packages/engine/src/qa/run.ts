// Aggregator: runs the applicable checks against a target (a video file, a captions file, a
// directory of published output, or any mix) and formats the result for a terse CLI/agent read.
import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { captionFormatFromPath, checkCaptions, parseCaptions, type CaptionCheckOptions } from './captions.js'
import { checkPersonalData, type PiiScanOptions } from './pii.js'
import { checkSecrets, type SecretScanOptions } from './secrets.js'
import { checkPlaceholders } from './placeholders.js'
import { checkVideo, type VideoCheckOptions } from './video.js'
import { qaCheck, type QaCheckResult } from './types.js'

export type { QaCheckResult } from './types.js'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv'])
const CAPTION_EXTENSIONS = new Set(['.srt', '.vtt'])

// Reader-facing deliverables only — never the engine's own bookkeeping that happens to sit
// alongside them (a page's `.aida.json` hash sidecar, `.aida-hash-cache.json`,
// `manifest.json`/`validation.json`/`run.json`/`pages-cache.json`, etc.), which QA used to pick
// up from a blanket `.md`/`.json`/`.html` extension match when a target was a whole directory —
// flagging epoch timestamps and ids inside them as PII/secrets and failing an otherwise-clean
// page. `.html` is for a PDF's source HTML (pdf/render.ts's `page.html`), not arbitrary markup;
// `.json` is reader-facing only for the two exact deliverable filenames below (plus `llms.txt`,
// which isn't JSON) — every other `.json` in a build/output tree is bookkeeping.
const READER_FACING_TEXT_EXTENSIONS = new Set(['.mdx', '.md', '.srt', '.vtt', '.html'])
const READER_FACING_EXACT_NAMES = new Set(['llms.txt', 'search-index.json', 'procedures.json'])

function isReaderFacingTextFile(file: string): boolean {
  const base = basename(file)
  if (READER_FACING_EXACT_NAMES.has(base)) return true
  const ext = extname(file).toLowerCase()
  if (ext === '.json') return false // only the exact deliverable names above, not bookkeeping json
  return READER_FACING_TEXT_EXTENSIONS.has(ext)
}

export interface RunQaOptions {
  video?: VideoCheckOptions | false
  captions?: CaptionCheckOptions | false
  personalData?: PiiScanOptions | false
  secrets?: SecretScanOptions | false
  /** Raw `{{placeholders}}` in reader-facing text (M35). Default on. */
  placeholders?: false
  /** Skip directories by name (e.g. 'node_modules', '.git') when target is a directory. Defaults cover both. */
  skipDirs?: string[]
}

export interface QaReport {
  ok: boolean
  target: string
  checks: QaCheckResult[]
}

function listFiles(dir: string, skipDirs: Set<string>): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...listFiles(full, skipDirs))
    else out.push(full)
  }
  return out
}

/**
 * Runs QA against `target`. If `target` is a directory, discovers video files, caption files,
 * and text files (md/srt/vtt/json/html) within it and runs the matching checks on each; if it's
 * a single file, runs only the checks that apply to its extension.
 */
export async function runQa(target: string, opts: RunQaOptions = {}): Promise<QaReport> {
  const stat = statSync(target)
  const skipDirs = new Set(opts.skipDirs ?? ['node_modules', '.git'])
  const files = stat.isDirectory() ? listFiles(target, skipDirs) : [target]

  const checks: QaCheckResult[] = []

  const videoFiles = files.filter((f) => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
  const captionFiles = files.filter((f) => CAPTION_EXTENSIONS.has(extname(f).toLowerCase()))
  const textFiles = files.filter((f) => isReaderFacingTextFile(f))

  if (opts.video !== false) {
    for (const file of videoFiles) {
      const results = await checkVideo(file, opts.video || {})
      checks.push(...results.map((r) => namespaced(r, file, files.length > 1)))
    }
  }

  if (opts.captions !== false) {
    for (const file of captionFiles) {
      const content = await readFile(file, 'utf8')
      try {
        const cues = parseCaptions(content, captionFormatFromPath(file))
        const results = checkCaptions(cues, opts.captions || {})
        checks.push(...results.map((r) => namespaced(r, file, files.length > 1)))
      } catch (err) {
        checks.push(namespaced(qaCheck('captions:parse', false, (err as Error).message, [(err as Error).message]), file, files.length > 1))
      }
    }
  }

  if (opts.personalData !== false) {
    for (const file of textFiles) {
      const content = await readFile(file, 'utf8')
      checks.push(namespaced(checkPersonalData(content, opts.personalData || {}), file, files.length > 1))
    }
  }

  if (opts.secrets !== false) {
    for (const file of textFiles) {
      const content = await readFile(file, 'utf8')
      checks.push(namespaced(checkSecrets(content, opts.secrets || {}), file, files.length > 1))
    }
  }

  if (opts.placeholders !== false) {
    for (const file of textFiles) {
      const content = await readFile(file, 'utf8')
      checks.push(namespaced(checkPlaceholders(content), file, files.length > 1))
    }
  }

  if (checks.length === 0) {
    checks.push(qaCheck('qa:no-input', false, `no applicable files found under ${target}`, [`no video/caption/text files found under ${target}`]))
  }

  return { ok: checks.every((c) => c.ok), target, checks }
}

function namespaced(result: QaCheckResult, file: string, includeFile: boolean): QaCheckResult {
  return { ...(includeFile ? { ...result, details: `[${file}] ${result.details}` } : result), file }
}

export interface FormatOptions {
  /** Cap total output lines (problems beyond this are summarized). Default 60. */
  maxLines?: number
}

/** Terse text report: one line per check, problems indented beneath, capped at maxLines total. */
export function formatQaReport(report: QaReport, opts: FormatOptions = {}): string {
  const maxLines = opts.maxLines ?? 60
  const lines: string[] = [`QA ${report.ok ? 'PASSED' : 'FAILED'} — ${report.target}`]
  for (const c of report.checks) {
    lines.push(`${c.ok ? 'pass' : 'FAIL'} — ${c.check}: ${c.details}`)
    for (const p of c.problems) lines.push(`    - ${p}`)
    if (lines.length >= maxLines) break
  }
  if (lines.length > maxLines) {
    const shown = lines.slice(0, maxLines)
    shown.push(`… truncated (${lines.length - maxLines} more lines)`)
    return shown.join('\n')
  }
  return lines.join('\n')
}

/** JSON-serializable form, for `--json` callers. */
export function toJson(report: QaReport): string {
  return JSON.stringify(report, null, 2)
}
