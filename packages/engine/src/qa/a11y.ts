// Accessibility checks (M42a, decision 39): alt text on reader-facing images, a video's
// transcript, and a PDF's tags/language/title. Each mirrors a deliverable `pages/alt-text.ts`,
// `render/transcript.ts` and `pdf/render.ts`'s `tagged`/`outline` + `pdf/build.ts`'s
// `applyPdfMetadata` already produce — these checks exist to catch the case where one of those
// didn't run (an older cached build, a hand-edited page).
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PDFBool, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { qaCheck, type QaCheckResult } from './types.js'

const HEADING = /^#{1,6}\s+(.*)$/
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const FENCE = /^(```|~~~)/
const INLINE_CODE = /`[^`\n]*`/g

/** A markdown heading's text, the way it'd read as a step heading (`#### 3. Title` -> `title`) —
 * numbering and emphasis markers stripped, lowercased, for comparing against an image's alt. */
function normalizeHeading(h: string): string {
  return h.replace(/^\d+\.\s*/, '').replace(/[*_`]/g, '').trim().toLowerCase()
}

/**
 * Every `![alt](src)` in reader-facing Markdown has non-empty alt text that isn't just the
 * nearest heading above it repeated verbatim — `pages/alt-text.ts`'s `stepAltText` exists
 * precisely so a step's screenshot describes more than the `#### N. Title` heading right above
 * it (a screen reader announces the heading already; repeating it in the image gives nothing new).
 */
export function checkAltText(content: string): QaCheckResult {
  const problems: string[] = []
  let heading = ''
  let count = 0
  let inFence = false
  for (const line of content.split('\n')) {
    if (FENCE.test(line.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = HEADING.exec(line)
    if (h) {
      heading = normalizeHeading(h[1])
      continue
    }
    // Inline code (`![fake](alt)` in a line of prose explaining markdown syntax, say) isn't a
    // real image — strip it before scanning, same as a whole fenced block above.
    for (const m of line.replace(INLINE_CODE, '').matchAll(IMAGE)) {
      count++
      const alt = m[1].trim()
      if (!alt) problems.push(`image with no alt text (${m[0].slice(0, 70)})`)
      else if (heading && alt.toLowerCase() === heading) problems.push(`alt text just repeats the heading above it: "${alt}"`)
    }
  }
  const ok = problems.length === 0
  return qaCheck('a11y:alt-text', ok, count === 0 ? 'no images' : `${count} image(s), ${problems.length} problem(s)`, problems)
}

/** `<id>.mp4` -> `<id>.transcript.md` (same for a path clip's `<id>.path-<p>.mp4`) —
 * `render/transcript.ts` always writes one next to the video it narrates. */
function transcriptPathFor(videoFile: string): string {
  return videoFile.replace(/\.(mp4|mov|webm|mkv)$/i, '.transcript.md')
}

/** A video's transcript file exists next to it and isn't empty. */
export function checkTranscript(videoFile: string): QaCheckResult {
  const file = transcriptPathFor(videoFile)
  if (!existsSync(file)) return qaCheck('a11y:transcript', false, 'no transcript file', [`missing transcript: ${file}`])
  const text = readFileSync(file, 'utf8').trim()
  if (!text) return qaCheck('a11y:transcript', false, 'transcript file is empty', [`empty transcript: ${file}`])
  return qaCheck('a11y:transcript', true, `${text.length} chars`)
}

/**
 * A PDF is tagged (`/MarkInfo /Marked true` and a `/StructTreeRoot`) and carries a `/Lang` and a
 * document Title — `pdf/render.ts`'s `tagged`/`outline` page.pdf() options and `pdf/build.ts`'s
 * `applyPdfMetadata` for the per-guide PDF/card. `manual.pdf` is metadata-only (its merge drops
 * tags — see the comment in `buildManualPdf`): untagged is expected for it by design, so only
 * its Title and Lang are checked, not the tagged-PDF structure.
 */
export async function checkPdfAccessibility(file: string): Promise<QaCheckResult> {
  if (!existsSync(file)) return qaCheck('a11y:pdf', false, 'no file', [`missing PDF: ${file}`])
  let doc
  try {
    doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false })
  } catch (err) {
    const message = (err as Error).message
    return qaCheck('a11y:pdf', false, message, [`could not parse ${file}: ${message}`])
  }
  const problems: string[] = []
  const isManual = basename(file) === 'manual.pdf'
  if (!isManual) {
    const markInfo = doc.catalog.lookup(PDFName.of('MarkInfo'))
    const marked = markInfo instanceof PDFDict ? markInfo.lookup(PDFName.of('Marked')) : undefined
    if (!(marked instanceof PDFBool) || !marked.asBoolean()) problems.push('not tagged — no /MarkInfo /Marked true')
    if (!doc.catalog.lookup(PDFName.of('StructTreeRoot'))) problems.push('no /StructTreeRoot — not a tagged (accessible) PDF')
  }
  const lang = doc.catalog.lookup(PDFName.of('Lang'))
  if (!(lang instanceof PDFString) || !lang.decodeText().trim()) problems.push('no /Lang set')
  if (!doc.getTitle()?.trim()) problems.push('no document Title set')
  const okLabel = isManual ? 'Title + Lang set' : 'tagged, Lang + Title set'
  return qaCheck('a11y:pdf', problems.length === 0, problems.length === 0 ? okLabel : problems.join('; '), problems)
}
