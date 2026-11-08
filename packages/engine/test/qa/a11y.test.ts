// M42a (decision 39): alt text, transcript and tagged-PDF accessibility checks.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { checkAltText, checkPdfAccessibility, checkTranscript } from '../../src/qa/a11y.js'

describe('checkAltText', () => {
  it('passes markdown where every image has its own, non-empty alt', () => {
    const md = '#### 1. Open Settings\n\nClick Settings.\n\n![Screenshot of Settings: click Settings.](screenshots/step-01.png)\n'
    const result = checkAltText(md)
    expect(result.ok).toBe(true)
  })

  it('flags an image with empty alt text', () => {
    const md = '#### 1. Open Settings\n\n![](screenshots/step-01.png)\n'
    const result = checkAltText(md)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/no alt text/)
  })

  it('flags alt text that just repeats the heading above it', () => {
    const md = '#### 1. Open Settings\n\n![Open Settings](screenshots/step-01.png)\n'
    const result = checkAltText(md)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/repeats the heading/)
  })

  it('ignores case and the step number prefix when comparing to the heading', () => {
    const md = '#### 3. Open Settings\n\n![open settings](screenshots/step-03.png)\n'
    const result = checkAltText(md)
    expect(result.ok).toBe(false)
  })

  it('passes markdown with no images at all', () => {
    expect(checkAltText('# Title\n\nJust words.\n').ok).toBe(true)
  })

  it('ignores an image-like pattern inside a fenced code block', () => {
    const md = '#### 1. Open Settings\n\n```\n![](screenshots/step-01.png)\n```\n'
    expect(checkAltText(md).ok).toBe(true)
  })

  it('ignores an image-like pattern inside a ~~~ fenced block', () => {
    const md = '#### 1. Open Settings\n\n~~~\n![](screenshots/step-01.png)\n~~~\n'
    expect(checkAltText(md).ok).toBe(true)
  })

  it('ignores an image-like pattern inside inline code', () => {
    const md = '#### 1. Open Settings\n\nWrite `![](src)` for an image.\n'
    expect(checkAltText(md).ok).toBe(true)
  })

  it('still catches a real problem outside the fenced block it sits next to', () => {
    const md = '#### 1. Open Settings\n\n```\n![](screenshots/step-01.png)\n```\n\n![](screenshots/step-02.png)\n'
    const result = checkAltText(md)
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(1)
  })
})

describe('checkTranscript', () => {
  const dirs: string[] = []
  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'aida-a11y-'))
    dirs.push(d)
    return d
  }

  it('passes when the transcript exists next to the video and is non-empty', () => {
    const dir = tmpDir()
    const video = join(dir, 'record-payment.mp4')
    writeFileSync(video, 'x')
    writeFileSync(join(dir, 'record-payment.transcript.md'), '# Record a payment\n\nSome narration.\n')
    expect(checkTranscript(video).ok).toBe(true)
  })

  it('fails when there is no transcript file', () => {
    const dir = tmpDir()
    const video = join(dir, 'record-payment.mp4')
    writeFileSync(video, 'x')
    const result = checkTranscript(video)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/missing transcript/)
  })

  it('fails when the transcript file is empty', () => {
    const dir = tmpDir()
    const video = join(dir, 'record-payment.mp4')
    writeFileSync(video, 'x')
    writeFileSync(join(dir, 'record-payment.transcript.md'), '   \n')
    expect(checkTranscript(video).ok).toBe(false)
  })

  it('finds a path clip transcript at the same naming convention', () => {
    const dir = tmpDir()
    const video = join(dir, 'record-payment.path-from-attendee.mp4')
    writeFileSync(video, 'x')
    writeFileSync(join(dir, 'record-payment.path-from-attendee.transcript.md'), 'Narration.\n')
    expect(checkTranscript(video).ok).toBe(true)
  })
})

describe('checkPdfAccessibility', () => {
  const dirs: string[] = []
  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'aida-a11y-pdf-'))
    dirs.push(d)
    return d
  }

  async function writePdf(file: string, opts: { tagged?: boolean; lang?: string; title?: string }): Promise<void> {
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    if (opts.title) doc.setTitle(opts.title)
    if (opts.lang) doc.setLanguage(opts.lang)
    if (opts.tagged) {
      doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }))
      doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.obj({ Type: 'StructTreeRoot' }))
    }
    writeFileSync(file, await doc.save())
  }

  it('passes a tagged PDF with a Lang and a Title', async () => {
    const file = join(tmpDir(), 'guide.pdf')
    await writePdf(file, { tagged: true, lang: 'en', title: 'A guide' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(true)
  })

  it('fails an untagged PDF', async () => {
    const file = join(tmpDir(), 'guide.pdf')
    await writePdf(file, { tagged: false, lang: 'en', title: 'A guide' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/not tagged/)
  })

  it('fails a tagged PDF with no language set', async () => {
    const file = join(tmpDir(), 'guide.pdf')
    await writePdf(file, { tagged: true, title: 'A guide' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/Lang/)
  })

  it('fails a tagged PDF with no title set', async () => {
    const file = join(tmpDir(), 'guide.pdf')
    await writePdf(file, { tagged: true, lang: 'en' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/Title/)
  })

  it('fails when the file is missing', async () => {
    const result = await checkPdfAccessibility(join(tmpDir(), 'missing.pdf'))
    expect(result.ok).toBe(false)
  })

  it('passes an untagged manual.pdf with a Lang and a Title (merge drops tags by design)', async () => {
    const file = join(tmpDir(), 'manual.pdf')
    await writePdf(file, { tagged: false, lang: 'en', title: 'The manual' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(true)
  })

  it('still fails manual.pdf when Lang or Title is missing', async () => {
    const file = join(tmpDir(), 'manual.pdf')
    await writePdf(file, { tagged: false, title: 'The manual' })
    const result = await checkPdfAccessibility(file)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/Lang/)
    expect(result.problems.join(' ')).not.toMatch(/tagged/)
  })
})
